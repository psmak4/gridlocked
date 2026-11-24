import { describe, expect, it } from "vitest";
import { createServerReporter } from "@/lib/server-reporter";
import { scrubAndReport } from "@/server/server-fn-errors";
import { envelopeFor, eventFromError, scrub } from "./report-error";

// M9 Task 10: errors reach Sentry, scrubbed. One scrubber for the browser's
// `beforeSend`, the server functions and the tick: codes and classes go,
// values stay behind.

const NOW = new Date("2026-11-23T12:00:00Z");
const DSN = "https://publickey@o123.ingest.us.sentry.io/456";

/** Everything a browser SDK might put on an event. */
function fullEvent() {
  return {
    event_id: "0123456789abcdef0123456789abcdef",
    timestamp: 1_795_000_000,
    platform: "javascript",
    level: "error" as const,
    release: "abc123",
    environment: "staging",
    message: "Failed for ada@example.test",
    logentry: { message: "Failed for ada@example.test" },
    exception: {
      values: [
        {
          type: "DrizzleQueryError",
          value: "insert into posts values ('my secret post', 'ada_l')",
          mechanism: { type: "onerror", handled: false },
          stacktrace: {
            frames: [
              {
                filename: "https://example.test/assets/main.js?token=abc",
                function: "submit",
                lineno: 10,
                colno: 4,
                in_app: true,
                vars: { body: "my secret post" },
                context_line: "const body = 'my secret post'",
              },
            ],
          },
        },
      ],
    },
    request: {
      url: "https://example.test/u/ada_l?invite=xyz",
      method: "POST",
      data: { body: "my secret post" },
      cookies: { session: "s3cret" },
      headers: {
        cookie: "session=s3cret",
        referer: "https://example.test/u/ada_l",
      },
      query_string: "invite=xyz",
    },
    user: { id: "u1", email: "ada@example.test", username: "ada_l" },
    breadcrumbs: [
      {
        timestamp: 1_794_999_999,
        category: "ui.click",
        level: "info" as const,
        type: "default",
        message: "button[aria-label='Reply to ada_l']",
        data: { url: "https://example.test/u/ada_l" },
      },
    ],
    extra: { email: "ada@example.test" },
    contexts: {
      browser: { name: "Firefox", version: "140" },
      os: { name: "macOS" },
      state: { form: { email: "ada@example.test" } },
    },
    tags: {
      code: "PASSWORD_TOO_COMMON",
      route: "/u/$username",
      url: "https://example.test/u/ada_l",
    },
    transaction: "/u/ada_l",
    debug_meta: {
      images: [{ type: "sourcemap", code_file: "main.js", debug_id: "d1" }],
    },
  };
}

describe("scrub", () => {
  it("scrub drops request bodies, cookies, headers, query strings, user, breadcrumbs' data and messages, and keeps the error class, code, route and release", () => {
    const out = scrub(fullEvent());
    expect(out).not.toBeNull();
    const text = JSON.stringify(out);
    for (const value of [
      "my secret post",
      "ada@example.test",
      "ada_l",
      "s3cret",
      "invite=xyz",
      "token=abc",
      "Reply to",
    ]) {
      expect(text).not.toContain(value);
    }
    expect(out).toMatchObject({
      release: "abc123",
      environment: "staging",
      level: "error",
      tags: { code: "PASSWORD_TOO_COMMON", route: "/u/$username" },
      exception: {
        values: [
          {
            type: "DrizzleQueryError",
            mechanism: { type: "onerror", handled: false },
            stacktrace: {
              frames: [
                {
                  filename: "https://example.test/assets/main.js",
                  function: "submit",
                  lineno: 10,
                  colno: 4,
                  in_app: true,
                },
              ],
            },
          },
        ],
      },
      breadcrumbs: [{ category: "ui.click", level: "info" }],
      contexts: { browser: { name: "Firefox", version: "140" } },
      debug_meta: { images: [{ debug_id: "d1" }] },
    });
    expect(out!.exception!.values![0]).not.toHaveProperty("value");
    expect(out).not.toHaveProperty("request");
    expect(out).not.toHaveProperty("user");
    expect(out).not.toHaveProperty("extra");
    expect(out).not.toHaveProperty("transaction");
    expect(out!.contexts).not.toHaveProperty("state");
  });

  it("drops an event that carries no error", () => {
    const message: Record<string, unknown> = fullEvent();
    delete message.exception;
    expect(scrub(message)).toBeNull();
  });
});

describe("the server reporter", () => {
  /** A reporter whose envelopes land in `sent`. */
  function recording() {
    const sent: { url: string; body: string }[] = [];
    const report = createServerReporter({
      dsn: DSN,
      release: "abc123",
      environment: "staging",
      now: () => NOW,
      fetch: async (url, init) => {
        sent.push({ url: String(url), body: String(init?.body) });
        return new Response(null, { status: 200 });
      },
    });
    return { sent, report };
  }

  it("an error thrown while handling a post reaches the reporter with no post text, email or username in it", async () => {
    // A database error's message carries the query's parameters (Ruling 59).
    class DrizzleQueryError extends Error {}
    const cause = new Error(
      "duplicate key value violates unique constraint, Key (email)=(ada@example.test)",
    );
    const error = new DrizzleQueryError(
      "Failed query: insert into posts (body, author) values ($1, $2)\nparams: my secret post,ada_l",
      { cause },
    );
    const { sent, report } = recording();

    const thrown = await scrubAndReport(error, {
      route: "src/community/server.ts#createPostFn",
      report,
    });

    expect(thrown).toEqual(new Error("server_error"));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(
      "https://o123.ingest.us.sentry.io/api/456/envelope/",
    );
    const body = sent[0]!.body;
    expect(body).toContain("DrizzleQueryError");
    expect(body).toContain("src/community/server.ts#createPostFn");
    expect(body).toContain("abc123");
    for (const value of [
      "my secret post",
      "ada@example.test",
      "ada_l",
      "Failed query",
    ]) {
      expect(body).not.toContain(value);
    }
  });

  it("sends nothing without a DSN", async () => {
    let calls = 0;
    const report = createServerReporter({
      dsn: undefined,
      now: () => NOW,
      fetch: async () => {
        calls += 1;
        return new Response(null);
      },
    });
    await report(new Error("boom"), "tick");
    expect(calls).toBe(0);
  });

  it("a send that fails is swallowed: reporting never adds an error of its own", async () => {
    const report = createServerReporter({
      dsn: DSN,
      now: () => NOW,
      fetch: async () => {
        throw new TypeError("network down");
      },
    });
    await expect(report(new Error("boom"), "tick")).resolves.toBeUndefined();
  });
});

describe("eventFromError and envelopeFor", () => {
  it("keeps the class of the error and its cause, the frames, and no message", () => {
    class ConfigError extends Error {}
    const event = eventFromError(
      new ConfigError("DATABASE_URL=postgres://user:pw@host/db", {
        cause: new TypeError("secret detail"),
      }),
      { route: "tick", now: NOW },
    );
    const text = JSON.stringify(event);
    expect(text).not.toContain("postgres://");
    expect(text).not.toContain("secret detail");
    const types = event.exception!.values!.map((v) => v.type);
    // Sentry lists the cause first and the error last.
    expect(types).toEqual(["TypeError", "ConfigError"]);
    const frames = event.exception!.values!.at(-1)!.stacktrace!.frames!;
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.at(-1)!.filename).toContain("report-error.test.ts");
    expect(event.tags).toMatchObject({ route: "tick" });
  });

  it("an envelope is the DSN's endpoint and its key", () => {
    const event = eventFromError(new Error("x"), { route: "tick", now: NOW });
    const envelope = envelopeFor(event, DSN)!;
    expect(envelope.url).toBe(
      "https://o123.ingest.us.sentry.io/api/456/envelope/",
    );
    const [header, item] = envelope.body.split("\n");
    expect(JSON.parse(header!)).toMatchObject({
      dsn: DSN,
      event_id: event.event_id,
    });
    expect(JSON.parse(item!)).toEqual({ type: "event" });
    expect(envelopeFor(event, "not a dsn")).toBeNull();
  });
});
