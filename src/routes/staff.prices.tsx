import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { ReasonField, reasonReady } from "@/components/staff/reason-field";
import { Button } from "@/components/ui/button";
import { formatDelta, formatMoney } from "@/lib/money";
import { privateHeaders } from "@/lib/private-headers";
import { cn } from "@/lib/utils";
import { getPrices, savePrice } from "@/server/staff";
import { STAFF_ERROR_WORDS } from "@/staff/errors";

/**
 * Prices (wave 5's price update board, M8 Task 9). Prices publish themselves
 * when an event becomes final (decision 1), so the board's **Publish prices**
 * is a status line. The table is the next event's list with each asset's
 * inputs; **Change one by hand** sets a price, with a reason, until the event
 * opens.
 */
export const Route = createFileRoute("/staff/prices")({
  loader: () => getPrices({ data: {} }),
  head: () => ({ meta: [{ title: "Prices · Staff · Gridlocked" }] }),
  headers: privateHeaders,
  component: Prices,
});

const eyebrow = "text-[12px] font-bold tracking-[0.12em] text-ink-muted";
const inputClass =
  "min-h-[48px] w-full rounded-radius-m border-2 border-line-strong bg-surface px-space-3 font-sans text-[16px] text-ink outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-focus-ring aria-invalid:border-fall";

type Board = Extract<
  Awaited<ReturnType<typeof getPrices>>,
  { ok: true }
>["value"];
type List = NonNullable<Board["prices"]>;
type Row = List["rows"][number];

function Prices() {
  const result = Route.useLoaderData();
  if (!result.ok) {
    return (
      <>
        <h1 className="font-display text-[36px] leading-[38px] font-normal uppercase">
          Prices
        </h1>
        <p role="alert" className="text-[16px] font-semibold text-fall">
          {STAFF_ERROR_WORDS[result.error]}
        </p>
      </>
    );
  }
  const { game, prices } = result.value;
  if (!game || !prices) {
    return (
      <>
        <h1 className="font-display text-[36px] leading-[38px] font-normal uppercase">
          Prices
        </h1>
        <p className="text-[16px] text-ink-muted">
          {game
            ? "No event is left to price this season."
            : "There's no game yet, so there are no prices."}
        </p>
      </>
    );
  }
  const { event, previous, counts } = prices;
  return (
    <>
      <header className="flex flex-col gap-space-1">
        <span className={eyebrow}>
          PRICES · ROUND {event.round} · {event.name.toUpperCase()}
        </span>
        <h1 className="font-display text-[36px] leading-[38px] font-normal uppercase">
          Prices
        </h1>
        <p role="status" className="text-[16px] font-semibold">
          {prices.publishedAfter
            ? `Published when the ${prices.publishedAfter.name} became final`
            : prices.published
              ? "Published"
              : "Not published yet"}
        </p>
        <p className="max-w-[760px] text-[14px] leading-[20px] text-ink-muted">
          Prices publish by themselves when an event becomes final. If none are
          published before the {event.name} opens, every price carries over
          {previous ? ` from the ${previous.name}` : ""}, unchanged.
        </p>
      </header>

      {prices.rows.length > 0 ? (
        <>
          <p className="text-[14px]">
            {counts.up} up · {counts.down} down · {counts.same} unchanged
            {counts.staff > 0 ? ` · ${counts.staff} set by staff` : ""}
          </p>
          <PriceTable rows={prices.rows} />
        </>
      ) : (
        <p className="rounded-radius-l bg-surface-raised p-space-4 text-[16px] text-ink-muted">
          No asset has a price yet.
        </p>
      )}

      <ChangeOne gameId={game.id} event={event} rows={prices.rows} />
    </>
  );
}

const COLUMNS = [
  "ASSET",
  "NOW",
  "LAST-3 AVG",
  "PRICE EXPECTS",
  "HOW IT DID",
  "CHANGE",
  "NEXT",
] as const;

/** A cell that shows its column's name beside it on a phone. */
const stacked =
  "py-[10px] max-sm:flex max-sm:items-center max-sm:gap-space-2 max-sm:py-[2px] max-sm:before:w-[120px] max-sm:before:text-[12px] max-sm:before:font-bold max-sm:before:tracking-[0.12em] max-sm:before:text-ink-muted max-sm:before:uppercase max-sm:before:content-[attr(data-label)] sm:px-space-2";

const money = (units: number | null) =>
  units === null ? "—" : formatMoney(units);
const pts = (n: number | null) =>
  n === null ? "—" : n.toLocaleString("en-GB", { maximumFractionDigits: 1 });

function PriceTable({ rows }: { rows: Row[] }) {
  return (
    <div className="rounded-radius-l bg-surface-raised">
      <table
        aria-label="Prices"
        className="w-full border-collapse text-left text-[16px]"
      >
        <thead className="max-sm:sr-only">
          <tr className="text-[12px] tracking-[0.12em] text-ink-muted">
            {COLUMNS.map((c, i) => (
              <th
                key={c}
                scope="col"
                className={cn(
                  "py-space-3 font-bold",
                  i === 0 || i === COLUMNS.length - 1
                    ? "px-space-4"
                    : "px-space-2",
                  i !== 0 && i !== 4 && "text-right",
                )}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.assetId}
              data-slot="price-row"
              data-staff={r.source === "admin" ? "" : undefined}
              className="border-t border-line max-sm:flex max-sm:flex-col max-sm:px-space-4 max-sm:py-space-2"
            >
              <td className="py-[10px] font-bold max-sm:py-[2px] sm:px-space-4">
                {r.name}
                {r.kind === "constructor" ? (
                  <span className="sr-only"> (constructor)</span>
                ) : null}
              </td>
              <td
                data-label="Now"
                className={cn(stacked, "font-numeric sm:text-right")}
              >
                {money(r.now)}
              </td>
              <td
                data-label="Last-3 avg"
                className={cn(stacked, "font-numeric sm:text-right")}
              >
                {pts(r.average)}
              </td>
              <td
                data-label="Price expects"
                className={cn(stacked, "font-numeric sm:text-right")}
              >
                {pts(r.expects)}
              </td>
              <td data-label="How it did" className={stacked}>
                {r.note ?? r.word ?? "—"}
              </td>
              <td
                data-label="Change"
                className={cn(
                  stacked,
                  "font-numeric font-bold sm:text-right",
                  r.change !== null && r.change < 0 && "text-fall",
                  r.change !== null && r.change > 0 && "text-rise",
                )}
              >
                {r.change === null ? "—" : formatDelta(r.change)}
              </td>
              <td
                data-label="Next"
                className={cn(
                  stacked,
                  "font-numeric font-bold sm:px-space-4 sm:text-right",
                )}
              >
                {money(r.next)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type Sent =
  { state: "idle" | "busy" } | { state: "done" | "error"; words: string };

const PRICE_TEXT = /^\d{1,3}(\.\d)?$/;

function ChangeOne({
  gameId,
  event,
  rows,
}: {
  gameId: string;
  event: List["event"];
  rows: Row[];
}) {
  const router = useRouter();
  const [assetId, setAsset] = useState("");
  const [price, setPrice] = useState("");
  const [reason, setReason] = useState("");
  const [tried, setTried] = useState(false);
  const [sent, setSent] = useState<Sent>({ state: "idle" });
  const units = PRICE_TEXT.test(price) ? Math.round(Number(price) * 10) : null;
  const priceOk = units !== null && units >= 30 && units <= 340;
  const picked = rows.find((r) => r.assetId === assetId);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (!picked || !priceOk || !reasonReady(reason)) return;
    setSent({ state: "busy" });
    const answer = await savePrice({
      data: { gameId, eventId: event.id, assetId, price, reason },
    });
    if (!answer.ok) {
      setSent({ state: "error", words: STAFF_ERROR_WORDS[answer.error] });
      return;
    }
    setSent({
      state: "done",
      words: `${picked.name} is ${formatMoney(answer.value.price)} for the ${event.name}.`,
    });
    setPrice("");
    setReason("");
    setTried(false);
    await router.invalidate();
  };

  return (
    <form
      aria-labelledby="change-one"
      onSubmit={submit}
      noValidate
      className="flex max-w-[640px] flex-col gap-space-3 rounded-radius-l border-2 border-ink p-space-4"
    >
      <h2 id="change-one" className={eyebrow}>
        CHANGE ONE BY HAND
      </h2>
      <p className="text-[14px] leading-[20px]">
        A price set here stays when the formula runs, and is fixed once the{" "}
        {event.name} opens.
      </p>
      <label className="flex flex-col gap-[6px] text-[14px] font-bold">
        Asset
        <select
          value={assetId}
          onChange={(e) => setAsset(e.target.value)}
          aria-invalid={tried && !picked ? true : undefined}
          className={inputClass}
        >
          <option value="">Pick a driver or constructor</option>
          {rows.map((r) => (
            <option key={r.assetId} value={r.assetId}>
              {r.name} ({money(r.next ?? r.now)})
            </option>
          ))}
        </select>
      </label>
      {tried && !picked ? (
        <p role="alert" className="text-[14px] font-semibold text-fall">
          Pick the asset to price.
        </p>
      ) : null}
      <label className="flex flex-col gap-[6px] text-[14px] font-bold">
        New price ($M)
        <input
          inputMode="decimal"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          aria-invalid={tried && !priceOk ? true : undefined}
          className={inputClass}
        />
      </label>
      {tried && !priceOk ? (
        <p role="alert" className="text-[14px] font-semibold text-fall">
          Give a price from 3.0 to 34.0, to one decimal place.
        </p>
      ) : null}
      <ReasonField
        value={reason}
        onChange={setReason}
        error={
          tried && !reasonReady(reason)
            ? STAFF_ERROR_WORDS.reason_required
            : undefined
        }
      />
      {sent.state === "error" ? (
        <p role="alert" className="text-[14px] font-semibold text-fall">
          {sent.words}
        </p>
      ) : sent.state === "done" ? (
        <p role="status" className="text-[14px] text-ink-muted">
          {sent.words}
        </p>
      ) : null}
      <Button
        type="submit"
        disabled={sent.state === "busy"}
        className="self-start"
      >
        Set price
      </Button>
    </form>
  );
}
