import { useState } from "react";
import { AssetRow } from "@/components/ui/asset-row";
import { EmptyState } from "@/components/ui/empty-state";
import { SpoilerCover } from "@/components/ui/spoiler-cover";
import { Tabs } from "@/components/ui/tabs";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { HowPricesWork, PriceBoard, PriceRow } from "@/play/prices";
import { teamValueWords } from "./price-words";

const eyebrow =
  "text-[12px] font-bold tracking-[0.12em] text-ink-muted uppercase";
const link =
  "inline-flex min-h-[44px] items-center self-start text-[16px] font-bold text-heat-text underline-offset-2 outline-none hover:underline focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-focus-ring";
const backLink =
  "flex min-h-[44px] items-center self-start text-[16px] font-bold text-ink-muted underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-focus-ring";
const h1 = "m-0 font-display text-[32px] leading-[34px] font-normal uppercase";

type Tab = "up" | "down" | "all";

/** "Mercedes · in 41% of teams". */
function subtitleOf(row: PriceRow): string {
  return row.ownership === null
    ? row.subtitle
    : `${row.subtitle} · in ${Math.round(row.ownership * 100)}% of teams`;
}

function PriceList({ rows, label }: { rows: PriceRow[]; label: string }) {
  return (
    <ul
      aria-label={label}
      className="m-0 flex list-none flex-col gap-space-2 p-0"
    >
      {rows.map((row) => (
        <li key={row.assetId}>
          <AssetRow
            code={row.code}
            teamColor={row.color}
            title={row.title}
            subtitle={subtitleOf(row)}
            figure={formatMoney(row.price)}
            delta={row.change === null ? undefined : row.change / 10}
            badges={row.yours ? [{ tone: "neutral", label: "Yours" }] : []}
          />
        </li>
      ))}
    </ul>
  );
}

type PricesScreenProps = {
  board: PriceBoard;
  signedIn: boolean;
  /** "Show it": the changes, on this page only. */
  onShow: () => void;
  /** "Mark as watched" for the race that moved them; signed in only. */
  markWatched?: () => void;
};

/**
 * Price changes (wave 3): going up and going down, every price, and your
 * team value. The changes are covered while the race that moved them is
 * hidden (M6 decision 4); current prices always show.
 */
export function PricesScreen({
  board,
  signedIn,
  onShow,
  markWatched,
}: PricesScreenProps) {
  const [tab, setTab] = useState<Tab>(board.changesFrom ? "up" : "all");
  if (!board.event) {
    return (
      <div className="px-space-4 pt-space-4">
        <EmptyState
          headingLevel={1}
          title="No prices yet"
          body="Prices show here once the first race is priced."
        />
      </div>
    );
  }
  const { event, changesFrom } = board;
  const covered = board.changesHidden && tab !== "all";
  const rows =
    tab === "up" ? board.up : tab === "down" ? board.down : board.all;
  const words = board.teamValue ? teamValueWords(board.teamValue.change) : null;

  return (
    <div className="flex flex-col gap-space-3 px-space-4 pt-space-4 pb-space-6 lg:max-w-[720px]">
      <div className="flex flex-col gap-[2px]">
        <span className={eyebrow}>
          {changesFrom
            ? `After round ${changesFrom.round} · fixed until ${event.name} locks`
            : `Round ${event.round} · ${event.name}`}
        </span>
        <h1 className={h1}>{changesFrom ? "Price changes" : "Prices"}</h1>
      </div>

      {board.teamValue ? (
        <section
          aria-label="Your team value"
          className="flex flex-col gap-[2px] rounded-radius-m bg-surface-raised px-[14px] py-space-3"
        >
          <span className={eyebrow}>
            {`Your team value · ${board.teamValue.teamName}`}
          </span>
          <span className="font-numeric text-[28px] font-bold">
            {formatMoney(board.teamValue.now)}
          </span>
          {words ? (
            <span
              className={cn(
                "text-[14px] font-bold",
                board.teamValue.change! > 0
                  ? "text-rise"
                  : board.teamValue.change! < 0
                    ? "text-fall"
                    : "text-ink-muted",
              )}
            >
              {words}
            </span>
          ) : board.changesHidden ? (
            <span className="text-[14px] text-ink-muted">
              {"Its change shows once you've watched the race."}
            </span>
          ) : null}
        </section>
      ) : !signedIn ? (
        <a href="/team" className={link}>
          Build a team
        </a>
      ) : null}

      {changesFrom ? (
        <Tabs
          label="Prices"
          items={[
            { id: "up", label: "Going up" },
            { id: "down", label: "Going down" },
            { id: "all", label: "All" },
          ]}
          value={tab}
          onChange={(id) => setTab(id as Tab)}
        />
      ) : null}

      {covered ? (
        <SpoilerCover
          hidden
          title={`Round ${changesFrom!.round} — price changes are in`}
          body="Who went up and down gives the race away. You haven't marked it as watched."
          onReveal={onShow}
          onMarkWatched={markWatched}
        />
      ) : rows.length === 0 ? (
        <p className="m-0 text-[16px] leading-[22px] text-ink-muted">
          {tab === "up"
            ? "No price went up this time."
            : tab === "down"
              ? "No price went down this time."
              : "No prices yet."}
        </p>
      ) : (
        <PriceList
          rows={rows}
          label={
            tab === "up"
              ? "Going up"
              : tab === "down"
                ? "Going down"
                : "All prices"
          }
        />
      )}

      <a href="/prices/how" className={link}>
        How prices work
      </a>
    </div>
  );
}

/** How prices work (wave 3): the rules, and one worked example. */
export function HowPricesScreen({ how }: { how: HowPricesWork | null }) {
  return (
    <div className="flex flex-col gap-space-3 px-space-4 pt-space-4 pb-space-6 lg:max-w-[720px]">
      <a href="/prices" className={backLink}>
        ← Price changes
      </a>
      <h1 className={h1}>How prices work</h1>
      {!how ? (
        <p className="m-0 text-[16px] leading-[22px] text-ink-muted">
          The formula shows here once the game is set up.
        </p>
      ) : (
        <>
          <p className="m-0 text-[16px] leading-[22px]">{how.intro}</p>
          <ul className="m-0 flex flex-col gap-space-2 pl-space-4 text-[16px] leading-[22px]">
            {how.rules.map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ul>
          <section
            aria-labelledby="worked-example"
            className="flex flex-col gap-space-3 rounded-radius-m bg-surface-raised p-space-4"
          >
            <div className="flex items-baseline justify-between gap-space-2">
              <h2
                id="worked-example"
                className="m-0 font-display text-[18px] leading-[22px] font-normal tracking-[0.02em] uppercase"
              >
                Worked example
              </h2>
              <span className={eyebrow}>{how.example.label}</span>
            </div>
            <ol className="m-0 flex list-none flex-col gap-space-3 p-0">
              {how.example.steps.map((step, i) => (
                <li key={step.title} className="flex items-start gap-space-3">
                  <span
                    aria-hidden
                    className="flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-full bg-surface font-numeric text-[14px] font-bold"
                  >
                    {i + 1}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-[16px] font-bold">{step.title}</span>
                    <span className="text-[14px] text-ink-muted">
                      {step.text}
                    </span>
                  </span>
                  <span className="font-numeric text-[16px] font-bold">
                    {step.value}
                  </span>
                </li>
              ))}
            </ol>
            <div className="flex flex-col gap-[2px] border-t border-line pt-space-3">
              <span className={eyebrow}>New price</span>
              <span className="font-numeric text-[20px] font-bold">
                {`${formatMoney(how.example.from)} → ${formatMoney(how.example.to)}`}
              </span>
            </div>
          </section>
          <p className="m-0 text-[14px] leading-[20px] text-ink-muted">
            {how.outro}
          </p>
        </>
      )}
    </div>
  );
}
