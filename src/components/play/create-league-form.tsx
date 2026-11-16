import { useState, type FormEvent } from "react";
import { selectClass } from "@/components/account-layout";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/text-field";
import type { GameErrorCode } from "@/game/errors";
import type { RoundChoice } from "@/play/leagues";
import { leagueRefusalWords } from "./league-words";

export type CreateLeagueData = {
  teamId: string;
  name: string;
  kind: "public" | "private";
  startRound?: number;
  endRound?: number;
};

export type CreateResult =
  | { ok: true; slug: string; joinCode: string }
  | { ok: false; error: GameErrorCode };

const legendClass = "mb-[6px] p-0 text-[14px] font-bold";

/** Native radios dressed as two tabs, so arrow keys work. */
function Choice<T extends string>({
  name,
  legend,
  value,
  options,
  onChange,
  hint,
}: {
  name: string;
  legend: string;
  value: T;
  options: Array<{ id: T; label: string }>;
  onChange: (next: T) => void;
  hint?: string;
}) {
  return (
    <fieldset className="m-0 flex flex-col border-0 p-0">
      <legend className={legendClass}>{legend}</legend>
      <div className="grid grid-cols-2 gap-[4px] rounded-radius-m bg-surface-sunken p-[4px]">
        {options.map((option) => (
          <label
            key={option.id}
            className="flex min-h-[44px] cursor-pointer items-center justify-center rounded-radius-s text-[16px] font-bold text-ink has-checked:bg-surface has-checked:ring-1 has-checked:ring-line-strong has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-focus-ring"
          >
            <input
              type="radio"
              name={name}
              className="sr-only"
              value={option.id}
              checked={value === option.id}
              onChange={() => onChange(option.id)}
            />
            {option.label}
          </label>
        ))}
      </div>
      {hint ? (
        <span className="mt-[6px] text-[14px] text-ink-muted">{hint}</span>
      ) : null}
    </fieldset>
  );
}

function RoundSelect({
  id,
  label,
  rounds,
  value,
  onChange,
}: {
  id: string;
  label: string;
  rounds: RoundChoice[];
  value: number;
  onChange: (round: number) => void;
}) {
  return (
    <div className="flex flex-col gap-[6px]">
      <label htmlFor={id} className="text-[14px] font-bold">
        {label}
      </label>
      <select
        id={id}
        className={selectClass}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      >
        {rounds.map((r) => (
          <option key={r.round} value={r.round}>
            {`Round ${r.round} · ${r.name}`}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Create a league (wave 3): its name, who can join, which races count, and
 * which of your teams is in it. There's no public list in M6, so "Anyone"
 * says what it means today: the code still lets people in.
 */
export function CreateLeagueForm({
  teams,
  rounds,
  create,
  onCreated,
}: {
  teams: Array<{ id: string; name: string }>;
  rounds: RoundChoice[];
  create: (data: CreateLeagueData) => Promise<CreateResult>;
  onCreated: (result: { slug: string; joinCode: string; name: string }) => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"private" | "public">("private");
  const [span, setSpan] = useState<"season" | "some">("season");
  const [from, setFrom] = useState(rounds[0]?.round ?? 1);
  const [to, setTo] = useState(rounds.at(-1)?.round ?? 1);
  const [teamId, setTeamId] = useState(teams[0]?.id ?? "");
  const [message, setMessage] = useState<string>();
  const [working, setWorking] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (working) return;
    setWorking(true);
    setMessage(undefined);
    try {
      const result = await create({
        teamId,
        name,
        kind,
        ...(span === "some" ? { startRound: from, endRound: to } : {}),
      });
      if (result.ok) {
        onCreated({
          slug: result.slug,
          joinCode: result.joinCode,
          name: name.trim(),
        });
      } else {
        setMessage(leagueRefusalWords(result.error));
      }
    } catch {
      setMessage(leagueRefusalWords("server_error"));
    } finally {
      setWorking(false);
    }
  }

  return (
    <form
      method="post"
      noValidate
      onSubmit={(e) => void submit(e)}
      className="flex flex-col gap-space-4"
    >
      <TextField
        id="league-name"
        label="League name"
        hint="Up to 40 characters. Everyone in it sees the name."
        autoComplete="off"
        maxLength={40}
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
      />
      <Choice
        name="kind"
        legend="Who can join"
        value={kind}
        onChange={setKind}
        options={[
          { id: "private", label: "With a code" },
          { id: "public", label: "Anyone" },
        ]}
        hint={
          kind === "private"
            ? "Only people you send the code to."
            : "Anyone with the code can join. Public lists come later."
        }
      />
      {rounds.length > 0 ? (
        <Choice
          name="span"
          legend="Which races count"
          value={span}
          onChange={setSpan}
          options={[
            { id: "season", label: "Whole season" },
            { id: "some", label: "Some races" },
          ]}
        />
      ) : null}
      {span === "some" && rounds.length > 0 ? (
        <div className="grid grid-cols-2 gap-space-2">
          <RoundSelect
            id="league-from"
            label="From"
            rounds={rounds}
            value={from}
            onChange={setFrom}
          />
          <RoundSelect
            id="league-to"
            label="To"
            rounds={rounds}
            value={to}
            onChange={setTo}
          />
        </div>
      ) : null}
      {teams.length > 1 ? (
        <div className="flex flex-col gap-[6px]">
          <label htmlFor="league-team" className="text-[14px] font-bold">
            Your team in this league
          </label>
          <select
            id="league-team"
            className={selectClass}
            value={teamId}
            onChange={(e) => setTeamId(e.target.value)}
          >
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {message ? (
        <p role="alert" className="m-0 text-[16px] font-semibold text-fall">
          {message}
        </p>
      ) : null}
      <Button type="submit" size="l" block disabled={working}>
        {working ? "Creating…" : "Create league"}
      </Button>
    </form>
  );
}
