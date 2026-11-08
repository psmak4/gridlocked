import { EmailCapError, EmailRejectedError, type EmailSender } from "./sender";

const SEND_TIMEOUT_MS = 10_000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Resend over `fetch` (POST https://api.resend.com/emails). The idempotency
 * key is the outbox id. Errors are mapped by status and Resend's error `name`;
 * no message built here includes the address, the link or the response text.
 *
 * - 422 only: the message can never go: EmailRejectedError. Resend uses
 *   `validation_error` on other statuses for account faults (an unverified
 *   domain, a bad `from`), which must not fail every queued email.
 * - 429 with a quota name only: EmailCapError.
 * - anything else (other 4xx/5xx, a timeout, a network failure): an ordinary
 *   error, which the outbox treats as a passing failure.
 *
 * The request times out after 10 s: the outbox holds its lock during a send.
 */
export function createResendSender({
  apiKey,
  from,
  fetch,
}: {
  apiKey: string;
  from: string;
  fetch: FetchLike;
}): EmailSender {
  return {
    async send(m) {
      let response: Response;
      try {
        response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key": m.idempotencyKey,
          },
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
          body: JSON.stringify({
            from,
            to: [m.to],
            subject: m.subject,
            text: m.text,
            html: m.html,
          }),
        });
      } catch {
        throw new Error("Resend request failed (network or timeout)");
      }

      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        // Not JSON; the status is enough.
      }
      const name =
        body && typeof body === "object" && "name" in body
          ? String((body as { name: unknown }).name)
          : "";

      if (response.ok) {
        const id =
          body && typeof body === "object" && "id" in body
            ? (body as { id: unknown }).id
            : undefined;
        if (typeof id !== "string" || id === "") {
          throw new Error("Resend answered without an id");
        }
        return { id };
      }
      if (response.status === 429 && /quota/.test(name)) {
        throw new EmailCapError();
      }
      if (response.status === 422) {
        throw new EmailRejectedError();
      }
      throw new Error(`Resend answered ${response.status}`);
    },
  };
}

/**
 * The sender from the function's environment, or null when `RESEND_API_KEY`
 * or `EMAIL_FROM` is unset or empty (GitHub passes a missing secret as "").
 */
export function senderFromEnv(
  env: Record<string, string | undefined>,
  fetch: FetchLike,
): EmailSender | null {
  const apiKey = env.RESEND_API_KEY;
  const from = env.EMAIL_FROM;
  if (!apiKey || !from) return null;
  return createResendSender({ apiKey, from, fetch });
}
