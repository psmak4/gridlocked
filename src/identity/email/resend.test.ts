import { describe, expect, it, vi } from "vitest";
import { EmailCapError, EmailRejectedError } from "./sender";
import { createResendSender, senderFromEnv } from "./resend";

const ADDRESS = "ada.lovelace@example.test";
const LINK = "https://gridlocked.example/auth/go?token=secret-token";
const MESSAGE = {
  idempotencyKey: "0194-outbox-id",
  to: ADDRESS,
  subject: "Your sign-in link",
  text: `Hello ${LINK}`,
  html: `<p>Hello ${LINK}</p>`,
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sender(respond: () => Promise<Response> | Response) {
  const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    async () => respond(),
  );
  return {
    fetch,
    sender: createResendSender({
      apiKey: "re_test_fake_key",
      from: "Gridlocked <noreply@mail.example.test>",
      fetch,
    }),
  };
}

describe("createResendSender", () => {
  it("posts the message with the idempotency key and returns the id", async () => {
    const { sender: s, fetch } = sender(() => json(200, { id: "msg_1" }));
    await expect(s.send(MESSAGE)).resolves.toEqual({ id: "msg_1" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer re_test_fake_key");
    expect(headers.get("idempotency-key")).toBe("0194-outbox-id");
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({
      from: "Gridlocked <noreply@mail.example.test>",
      to: [ADDRESS],
      subject: MESSAGE.subject,
      text: MESSAGE.text,
      html: MESSAGE.html,
    });
  });

  it("a 422 is EmailRejectedError", async () => {
    const { sender: s } = sender(() =>
      json(422, { name: "validation_error", message: `bad ${ADDRESS}` }),
    );
    await expect(s.send(MESSAGE)).rejects.toBeInstanceOf(EmailRejectedError);
  });

  it("a 429 quota error is EmailCapError", async () => {
    for (const name of ["daily_quota_exceeded", "monthly_quota_exceeded"]) {
      const { sender: s } = sender(() =>
        json(429, { name, message: "You have reached your quota" }),
      );
      await expect(s.send(MESSAGE)).rejects.toBeInstanceOf(EmailCapError);
    }
  });

  it("a plain 429 rate limit is an ordinary error", async () => {
    const { sender: s } = sender(() =>
      json(429, { name: "rate_limit_exceeded", message: "slow down" }),
    );
    const error = await s.send(MESSAGE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(EmailCapError);
    expect(error).not.toBeInstanceOf(EmailRejectedError);
  });

  it("a validation_error on any status but 422 is an ordinary error", async () => {
    // Resend uses it for account faults (an unverified domain, a bad `from`).
    for (const status of [400, 403]) {
      const { sender: s } = sender(() =>
        json(status, { name: "validation_error", message: "domain" }),
      );
      const error = await s.send(MESSAGE).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(EmailCapError);
      expect(error).not.toBeInstanceOf(EmailRejectedError);
    }
  });

  it("a quota name on a 403 is an ordinary error", async () => {
    const { sender: s } = sender(() =>
      json(403, { name: "daily_quota_exceeded", message: "quota" }),
    );
    const error = await s.send(MESSAGE).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(EmailCapError);
  });

  it("the request times out after 10 seconds, as an ordinary error", async () => {
    const timeout = new AbortController();
    const spy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(timeout.signal);
    try {
      let seen: AbortSignal | null | undefined;
      const hang = vi.fn((_url: string, init?: RequestInit) => {
        seen = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "TimeoutError")),
          );
        });
      });
      const s = createResendSender({
        apiKey: "k",
        from: "a@b.test",
        fetch: hang,
      });
      const pending = s.send(MESSAGE).catch((e: unknown) => e);
      expect(spy).toHaveBeenCalledWith(10_000);
      expect(seen).toBe(timeout.signal);
      timeout.abort();
      const error = (await pending) as Error;
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(EmailCapError);
      expect(error).not.toBeInstanceOf(EmailRejectedError);
      expect(error.message).not.toContain("example.test");
    } finally {
      spy.mockRestore();
    }
  });

  it("a 500 throws an ordinary error", async () => {
    const { sender: s } = sender(() => json(500, { message: "boom" }));
    const error = await s.send(MESSAGE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(EmailCapError);
    expect(error).not.toBeInstanceOf(EmailRejectedError);
  });

  it("no address or link appears in an error message", async () => {
    const bodies = [
      json(422, { name: "validation_error", message: `${ADDRESS} ${LINK}` }),
      json(429, {
        name: "daily_quota_exceeded",
        message: `${ADDRESS} ${LINK}`,
      }),
      json(500, { message: `${ADDRESS} ${LINK}` }),
      json(200, { message: `${ADDRESS} ${LINK}` }),
    ];
    for (const body of bodies) {
      const { sender: s } = sender(() => body.clone());
      const error = (await s.send(MESSAGE).catch((e: unknown) => e)) as Error;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).not.toContain("example.test");
      expect(error.message).not.toContain("secret-token");
    }
    const { sender: s } = sender(() => {
      throw new TypeError(`connect failed for ${ADDRESS} ${LINK}`);
    });
    const error = (await s.send(MESSAGE).catch((e: unknown) => e)) as Error;
    expect(error.message).not.toContain("example.test");
    expect(error.message).not.toContain("secret-token");
    expect(error.cause).toBeUndefined();
  });
});

describe("senderFromEnv", () => {
  const fetch = vi.fn();
  it("is null unless both values are set and non-empty", () => {
    expect(senderFromEnv({}, fetch)).toBeNull();
    expect(senderFromEnv({ RESEND_API_KEY: "k" }, fetch)).toBeNull();
    expect(senderFromEnv({ EMAIL_FROM: "a@b.test" }, fetch)).toBeNull();
    expect(
      senderFromEnv({ RESEND_API_KEY: "", EMAIL_FROM: "a@b.test" }, fetch),
    ).toBeNull();
    expect(
      senderFromEnv({ RESEND_API_KEY: "k", EMAIL_FROM: "a@b.test" }, fetch),
    ).not.toBeNull();
  });
});
