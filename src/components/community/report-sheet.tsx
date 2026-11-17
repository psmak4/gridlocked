import { useId, useState } from "react";
import type { CommunityRefusal } from "@/community/errors";
import {
  REPORT_NOTE_MAX,
  REPORT_REASONS,
  type ReportableType,
  type ReportReason,
} from "@/community/report-values";
import { Turnstile } from "@/components/turnstile";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { TextField } from "@/components/ui/text-field";
import { FAILED, refusalWords } from "./forum-words";

/** What is being reported, and how the sheet names it. */
export type ReportTarget = {
  targetType: ReportableType;
  targetId: string;
  /** "this post by late_braker" */
  what: string;
};

export type ReportSubmission = {
  targetType: ReportableType;
  targetId: string;
  reason: ReportReason;
  note?: string;
  contact?: string;
  captchaToken?: string;
};

export type ReportOutcome = { ok: true } | CommunityRefusal;

export const REASON_WORDS: Record<ReportReason, string> = {
  spam: "Spam",
  abuse: "Abuse or harassment",
  spoiler: "An unmarked spoiler",
  off_topic: "Off topic",
  illegal: "Illegal content",
  copyright: "Copyright infringement",
  other: "Something else",
};

/**
 * "Report" (wave 4): a reason, an optional note and, logged out, an email
 * address and the bot check (DM 5.8). Keyed by its target, so each report
 * starts blank.
 */
export function ReportSheet({
  target,
  visitor,
  onClose,
  submit,
}: {
  target: ReportTarget | null;
  visitor: boolean;
  onClose: () => void;
  submit: (report: ReportSubmission) => Promise<ReportOutcome>;
}) {
  return (
    <Sheet
      open={target !== null}
      onClose={onClose}
      title="Report"
      actions={null}
    >
      {target ? (
        <ReportForm
          key={target.targetId}
          target={target}
          visitor={visitor}
          onClose={onClose}
          submit={submit}
        />
      ) : null}
    </Sheet>
  );
}

function ReportForm({
  target,
  visitor,
  onClose,
  submit,
}: {
  target: ReportTarget;
  visitor: boolean;
  onClose: () => void;
  submit: (report: ReportSubmission) => Promise<ReportOutcome>;
}) {
  const id = useId();
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [note, setNote] = useState("");
  const [contact, setContact] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  if (sent) {
    return (
      <div className="flex flex-col gap-space-3">
        <p role="status" className="m-0 text-[16px]">
          Thanks. A moderator will take a look.
        </p>
        <Button block onClick={onClose}>
          Done
        </Button>
      </div>
    );
  }

  const ready =
    reason !== null &&
    !sending &&
    (!visitor || (contact.trim().length > 0 && token !== null));

  return (
    <form
      className="flex flex-col gap-space-3"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!ready || reason === null) return;
        setSending(true);
        setError(null);
        try {
          const result = await submit({
            targetType: target.targetType,
            targetId: target.targetId,
            reason,
            ...(note.trim() ? { note: note.trim() } : {}),
            ...(visitor
              ? { contact: contact.trim(), captchaToken: token ?? "" }
              : {}),
          });
          if (result.ok) setSent(true);
          else setError(refusalWords(result));
        } catch {
          setError(FAILED);
        } finally {
          setSending(false);
          // A token works once.
          if (visitor) {
            setToken(null);
            setResetKey((k) => k + 1);
          }
        }
      }}
    >
      <p className="m-0 text-[14px] text-ink-muted">{`Reporting ${target.what}.`}</p>
      <fieldset className="m-0 flex flex-col gap-space-1 border-0 p-0">
        <legend className="mb-space-1 text-[14px] font-bold">
          {"What's wrong with it?"}
        </legend>
        {REPORT_REASONS.map((value) => (
          <label
            key={value}
            className="flex min-h-[44px] items-center gap-space-2 text-[16px]"
          >
            <input
              type="radio"
              name={`${id}-reason`}
              value={value}
              checked={reason === value}
              onChange={() => setReason(value)}
              className="size-[20px] accent-heat"
            />
            {REASON_WORDS[value]}
          </label>
        ))}
      </fieldset>
      <div className="flex flex-col gap-[6px]">
        <label htmlFor={`${id}-note`} className="text-[14px] font-bold">
          Anything else? (optional)
        </label>
        <textarea
          id={`${id}-note`}
          value={note}
          maxLength={REPORT_NOTE_MAX}
          rows={3}
          onChange={(e) => setNote(e.target.value)}
          className="rounded-radius-m border-2 border-line-strong bg-surface px-space-3 py-space-2 font-sans text-[16px] text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        />
      </div>
      {visitor ? (
        <>
          <TextField
            id={`${id}-contact`}
            label="Your email"
            type="email"
            autoComplete="email"
            required
            value={contact}
            onChange={(e) => setContact(e.target.value)}
            hint="Only to tell you what happens. It's deleted once a moderator decides."
          />
          <Turnstile onToken={setToken} resetKey={resetKey} />
        </>
      ) : null}
      {error ? (
        <p role="alert" className="m-0 text-[14px] font-semibold text-fall">
          {error}
        </p>
      ) : null}
      <Button type="submit" block disabled={!ready}>
        {sending ? "Sending…" : "Send report"}
      </Button>
    </form>
  );
}
