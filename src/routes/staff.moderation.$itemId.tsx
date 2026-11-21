import { useState } from "react";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { ReasonField, reasonReady } from "@/components/staff/reason-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { trustWords } from "@/lib/settings-words";
import { privateHeaders } from "@/lib/private-headers";
import { getModItem, moderateItem } from "@/server/staff";
import { STAFF_ERROR_WORDS } from "@/staff/errors";
import { reasonWords, TYPE_WORDS } from "./staff.moderation";

/**
 * One moderation item's panel (wave 5, M8 Task 11), beside the queue: what
 * was posted as it was at the first report, the reports by reason, and the
 * author. Then the note the author sees, the two actions that fit, and
 * "Keep it, close reports". A decision someone else beat says so, and the
 * panel shows the item as it now stands.
 */
export const Route = createFileRoute("/staff/moderation/$itemId")({
  loader: ({ params }) => getModItem({ data: { id: params.itemId } }),
  head: () => ({ meta: [{ title: "Moderation item · Staff · Gridlocked" }] }),
  headers: privateHeaders,
  component: ModerationPanel,
});

const eyebrow = "text-[12px] font-bold tracking-[0.12em] text-ink-muted";
const panel =
  "flex min-w-0 flex-[2_1_360px] flex-col gap-space-4 rounded-radius-l border-2 border-ink p-space-5";
const NOTE_LABEL = "Note to the author (they see this, and can appeal)";

type Sent =
  { state: "idle" | "busy" } | { state: "done" | "error"; words: string };

function ModerationPanel() {
  const result = Route.useLoaderData();
  const router = useRouter();
  const [note, setNote] = useState("");
  const [title, setTitle] = useState("");
  const [tried, setTried] = useState(false);
  const [sent, setSent] = useState<Sent>({ state: "idle" });

  if (!result.ok) {
    return (
      <section className={panel}>
        <p role="alert" className="text-[16px] font-semibold text-fall">
          {STAFF_ERROR_WORDS[result.error]}
        </p>
      </section>
    );
  }
  const item = result.value;
  const open = item.status === "open";
  const needsTitle = item.actions.some((a) => a.needsTitle);

  const act = async (action: string, label: string, wantsTitle: boolean) => {
    setTried(true);
    if (!reasonReady(note)) return;
    if (wantsTitle && !title.trim()) return;
    setSent({ state: "busy" });
    const answer = await moderateItem({
      data: {
        id: item.id,
        version: item.version,
        action,
        reason: note,
        ...(wantsTitle ? { title } : {}),
      },
    });
    if (answer.ok) {
      setSent({ state: "done", words: `${label}: done. It's in Done now.` });
      setNote("");
      setTitle("");
      setTried(false);
    } else {
      setSent({ state: "error", words: STAFF_ERROR_WORDS[answer.error] });
    }
    // Either way, show the item as it now stands.
    await router.invalidate();
  };

  const trust =
    item.author.trustLevel === null
      ? null
      : trustWords(item.author.trustLevel).name;

  return (
    <section
      aria-labelledby="mod-heading"
      key={item.id}
      data-slot="mod-panel"
      className={panel}
    >
      <div className="flex flex-col gap-space-1">
        <span className={eyebrow}>
          {reasonWords(item.reason).toUpperCase()} ·{" "}
          {(TYPE_WORDS[item.type] ?? item.type).toUpperCase()}
        </span>
        <h2
          id="mod-heading"
          className="m-0 font-display text-[24px] leading-[28px] font-normal uppercase"
        >
          {item.where || (TYPE_WORDS[item.type] ?? item.type)}
        </h2>
        <span className="flex flex-wrap items-center gap-space-2 text-[14px] text-ink-muted">
          <Badge tone={item.state === "Auto-hidden" ? "caution" : "neutral"}>
            {item.state}
          </Badge>
          Reported {item.ageLabel}
        </span>
      </div>

      <div className="flex flex-col gap-space-2">
        <h3 className={eyebrow}>WHAT WAS POSTED · SNAPSHOT AT FIRST REPORT</h3>
        <blockquote
          data-slot="mod-snapshot"
          className="m-0 flex flex-col gap-space-1 rounded-radius-m bg-surface-raised p-space-3 text-[16px] leading-[24px] break-words whitespace-pre-wrap"
        >
          {item.snapshot.title ? (
            <span className="font-bold">{item.snapshot.title}</span>
          ) : null}
          <span>{item.snapshot.body}</span>
          <span className="text-[14px] text-ink-muted">
            Posted {item.postedLabel}
          </span>
        </blockquote>
        {item.snapshot.edits.length > 0 ? (
          <p className="text-[14px] text-ink-muted">
            {item.snapshot.edits.length === 1
              ? "Edited once since."
              : `Edited ${item.snapshot.edits.length} times since.`}{" "}
            Latest: “{item.snapshot.edits.at(-1)!.body}”
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-space-2">
        <h3 className={eyebrow}>REPORTS</h3>
        {item.byReason.length === 0 ? (
          <p className="text-[16px]">None: the filter raised it.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-[2px] p-0 text-[16px]">
            {item.byReason.map((r) => (
              <li key={r.reason}>
                <span className="font-bold">{reasonWords(r.reason)}</span> ·{" "}
                {r.count}
              </li>
            ))}
          </ul>
        )}
        {item.notes.length > 0 ? (
          <ul className="m-0 flex list-none flex-col gap-[2px] p-0 text-[14px] text-ink-muted">
            {item.notes.map((n, i) => (
              <li key={i}>“{n}”</li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="flex flex-col gap-space-2">
        <h3 className={eyebrow}>ABOUT THE AUTHOR</h3>
        <dl className="m-0 grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-space-3 gap-y-space-1 text-[16px]">
          <dt className="text-ink-muted">Username</dt>
          <dd className="m-0 font-semibold break-words">
            {item.author.username}
          </dd>
          {trust ? (
            <>
              <dt className="text-ink-muted">Trust</dt>
              <dd className="m-0 font-semibold">{trust}</dd>
            </>
          ) : null}
          {item.author.joined ? (
            <>
              <dt className="text-ink-muted">Joined</dt>
              <dd className="m-0 font-semibold">{item.author.joined}</dd>
            </>
          ) : null}
          <dt className="text-ink-muted">Posts</dt>
          <dd className="m-0 font-semibold">{item.author.posts}</dd>
          <dt className="text-ink-muted">Earlier actions</dt>
          <dd className="m-0 font-semibold">{item.author.earlier}</dd>
        </dl>
      </div>

      {sent.state === "error" ? (
        <p role="alert" className="text-[14px] font-semibold text-fall">
          {sent.words}
        </p>
      ) : sent.state === "done" ? (
        <p role="status" className="text-[14px]">
          {sent.words}
        </p>
      ) : null}

      {open ? (
        <form
          aria-label="Decide this item"
          onSubmit={(e) => e.preventDefault()}
          noValidate
          className="flex flex-col gap-space-3"
        >
          <ReasonField
            label={NOTE_LABEL}
            value={note}
            onChange={setNote}
            error={
              tried && !reasonReady(note)
                ? STAFF_ERROR_WORDS.reason_required
                : undefined
            }
          />
          {needsTitle ? (
            <label className="flex flex-col gap-[6px] text-[14px] font-bold">
              New title, without the spoiler (to retitle)
              <input
                value={title}
                maxLength={120}
                onChange={(e) => setTitle(e.target.value)}
                className="min-h-[44px] rounded-radius-m border-2 border-line-strong bg-surface px-space-3 font-sans text-[16px] font-normal text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
              />
            </label>
          ) : null}
          <div className="flex flex-wrap gap-space-3">
            {item.actions.map((a) => (
              <Button
                key={`${a.action}-${a.on}`}
                type="button"
                variant={a.action === "restore" ? "secondary" : "primary"}
                disabled={sent.state === "busy"}
                onClick={() => void act(a.action, a.label, !!a.needsTitle)}
              >
                {a.label}
              </Button>
            ))}
          </div>
        </form>
      ) : (
        <p className="text-[16px]">
          {item.state}
          {item.resolution ? ` · ${item.resolution}` : ""}
          {item.resolvedLabel ? ` · ${item.resolvedLabel}` : ""}
        </p>
      )}

      <Link
        to="/staff/moderation"
        search={{ tab: open ? "open" : "done" }}
        className="flex min-h-[44px] items-center self-start text-[16px] text-ink underline outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring lg:hidden"
      >
        Back to the queue
      </Link>
    </section>
  );
}
