import { useState } from "react";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { ReasonField, reasonReady } from "@/components/staff/reason-field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { privateHeaders } from "@/lib/private-headers";
import { getReviewItem, resolveReview } from "@/server/staff";
import { STAFF_ERROR_WORDS } from "@/staff/errors";

/**
 * One review item's panel (wave 5, M8 Task 10), beside the queue: what was
 * found, the evidence, what it holds up, then a reason and the actions. A
 * "Go to …" action is a link; the others resolve the item. A resolve someone
 * else beat says so, and the panel shows the item as it now stands.
 */
export const Route = createFileRoute("/staff/review/$itemId")({
  loader: ({ params }) => getReviewItem({ data: { id: params.itemId } }),
  head: () => ({ meta: [{ title: "Review item · Staff · Gridlocked" }] }),
  headers: privateHeaders,
  component: ReviewPanel,
});

const eyebrow = "text-[12px] font-bold tracking-[0.12em] text-ink-muted";
const panel =
  "flex min-w-0 flex-[2_1_360px] flex-col gap-space-4 rounded-radius-l border-2 border-ink p-space-5";

type Sent =
  { state: "idle" | "busy" } | { state: "done" | "error"; words: string };

function ReviewPanel() {
  const result = Route.useLoaderData();
  const router = useRouter();
  const [reason, setReason] = useState("");
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
  const resolves = item.actions.filter((a) => !a.href);
  const links = item.actions.filter((a) => a.href);

  const act = async (actionId: string, label: string) => {
    setTried(true);
    if (!reasonReady(reason)) return;
    setSent({ state: "busy" });
    const answer = await resolveReview({
      data: { id: item.id, version: item.version, actionId, reason },
    });
    if (answer.ok) {
      setSent({
        state: "done",
        words:
          answer.value.status === "dismissed"
            ? "Dismissed. It's in Resolved now."
            : `${label}: done. It's in Resolved now.`,
      });
      setReason("");
      setTried(false);
    } else {
      setSent({ state: "error", words: STAFF_ERROR_WORDS[answer.error] });
    }
    // Either way, show the item as it now stands.
    await router.invalidate();
  };

  return (
    <section
      aria-labelledby="review-heading"
      key={item.id}
      data-slot="review-panel"
      className={panel}
    >
      <div className="flex flex-col gap-space-1">
        <span className={eyebrow}>
          {item.event
            ? `ROUND ${item.event.round} · ${item.event.name.toUpperCase()}`
            : "NO EVENT"}
        </span>
        <h2
          id="review-heading"
          className="m-0 font-display text-[24px] leading-[28px] font-normal uppercase"
        >
          {item.title}
        </h2>
        <span className="flex flex-wrap items-center gap-space-2 text-[14px] text-ink-muted">
          {open ? (
            <Badge tone={item.severity === "blocking" ? "caution" : "neutral"}>
              {item.severity === "blocking" ? "Holds scoring" : "Warning"}
            </Badge>
          ) : (
            <Badge>
              {item.status === "dismissed" ? "Dismissed" : "Resolved"}
            </Badge>
          )}
          Found {item.openedLabel}
        </span>
      </div>

      <p className="text-[16px] leading-[24px]">{item.summary}</p>

      {item.evidence.length > 0 ? (
        <div className="flex flex-col gap-space-2">
          <h3 className={eyebrow}>EVIDENCE</h3>
          <dl className="m-0 grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-space-3 gap-y-space-1 text-[16px]">
            {item.evidence.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-ink-muted">{label}</dt>
                <dd className="m-0 font-semibold break-words">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      <p
        data-slot="review-held"
        className="rounded-radius-m bg-surface-raised p-space-3 text-[16px] font-semibold"
      >
        {item.held ??
          (open
            ? "Scoring isn't held: this is a warning."
            : "Nothing is held now.")}
      </p>

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
            value={reason}
            onChange={setReason}
            error={
              tried && !reasonReady(reason)
                ? STAFF_ERROR_WORDS.reason_required
                : undefined
            }
          />
          <div className="flex flex-wrap gap-space-3">
            {resolves.map((a) => (
              <Button
                key={a.id}
                type="button"
                variant={a.id === "dismiss" ? "secondary" : "primary"}
                disabled={sent.state === "busy"}
                onClick={() => void act(a.id, a.label)}
              >
                {a.label}
              </Button>
            ))}
          </div>
          {links.length > 0 ? (
            <ul className="m-0 flex list-none flex-wrap gap-space-3 p-0">
              {links.map((a) => (
                <li key={a.id}>
                  <a
                    href={a.href!}
                    className="flex min-h-[44px] items-center text-[16px] font-bold text-ink underline outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                  >
                    {a.label}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
        </form>
      ) : (
        <p className="text-[16px]">
          {item.resolution}
          {item.resolvedLabel ? ` · ${item.resolvedLabel}` : ""}
          {item.reason ? ` · “${item.reason}”` : ""}
        </p>
      )}

      <Link
        to="/staff/review"
        search={{ tab: open ? "open" : "resolved" }}
        className="flex min-h-[44px] items-center self-start text-[16px] text-ink underline outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring lg:hidden"
      >
        Back to the queue
      </Link>
    </section>
  );
}
