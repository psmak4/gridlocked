import { useState, type FormEvent } from "react";
import { FormMessage } from "@/components/account-layout";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { TextField } from "@/components/ui/text-field";
import type { GameErrorCode } from "@/game/errors";
import type { TeamSummary } from "@/play/teams";

/** A team refusal, in plain words. */
export function teamRefusalWords(code: GameErrorCode | null): string {
  switch (code) {
    case "bad_name":
      return "A team name is 1 to 30 characters.";
    case "no_free_slot":
      return "Every team slot is taken.";
    case "game_not_open":
      return "The game isn't open yet.";
    case "team_not_owned":
      return "That team isn't yours.";
    case "team_retired":
      return "A retired team can't be changed.";
    default:
      return "That didn't work. Try again.";
  }
}

type Result = { ok: true } | { ok: false; error: GameErrorCode };

/**
 * Runs a team change, answering with the words for a refusal, or for a
 * failure that isn't one (a dropped connection, a server error).
 */
async function attempt(run: () => Promise<Result>): Promise<string | null> {
  try {
    const result = await run();
    return result.ok ? null : teamRefusalWords(result.error);
  } catch {
    return teamRefusalWords(null);
  }
}

/** The name field and "Create a team". `create` answers the new slot. */
export function CreateTeamForm({
  create,
  onCreated,
}: {
  create: (
    name: string,
  ) => Promise<
    { ok: true; slot: number } | { ok: false; error: GameErrorCode }
  >;
  onCreated: (slot: number) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [message, setMessage] = useState<string>();
  const [working, setWorking] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (working) return;
    setMessage(undefined);
    setWorking(true);
    const fail = (words: string) => {
      setWorking(false);
      setMessage(words);
    };
    try {
      const result = await create(name);
      if (!result.ok) return fail(teamRefusalWords(result.error));
      await onCreated(result.slot);
    } catch {
      fail(teamRefusalWords(null));
    }
  }

  return (
    <form
      method="post"
      noValidate
      onSubmit={submit}
      className="flex w-full max-w-[400px] flex-col gap-space-3 text-left"
    >
      <TextField
        id="team-name"
        name="name"
        label="Team name"
        hint="1 to 30 characters."
        autoComplete="off"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <FormMessage>{message}</FormMessage>
      <Button type="submit" block disabled={working}>
        Create a team
      </Button>
    </form>
  );
}

/**
 * "Rename team": a sheet with the name field. Give it `key={team?.id}`, so
 * each team starts with its own name and no message.
 */
export function RenameTeamSheet({
  team,
  onClose,
  rename,
  onDone,
}: {
  team: TeamSummary | null;
  onClose: () => void;
  rename: (teamId: string, name: string) => Promise<Result>;
  onDone: () => Promise<void>;
}) {
  const [name, setName] = useState(team?.name ?? "");
  const [message, setMessage] = useState<string>();
  const [working, setWorking] = useState(false);

  async function save(event?: FormEvent) {
    event?.preventDefault();
    if (!team || working) return;
    setMessage(undefined);
    setWorking(true);
    const error = await attempt(() => rename(team.id, name));
    if (error) {
      setWorking(false);
      setMessage(error);
      return;
    }
    await onDone();
  }

  return (
    <Sheet
      open={team !== null}
      onClose={onClose}
      title="Rename team"
      actions={
        <Button type="submit" form="rename-team-form" block disabled={working}>
          Save
        </Button>
      }
    >
      <form
        id="rename-team-form"
        method="post"
        noValidate
        onSubmit={save}
        className="flex flex-col gap-space-3"
      >
        <TextField
          id="rename-team-name"
          name="name"
          label="Team name"
          hint="1 to 30 characters."
          autoComplete="off"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <FormMessage>{message}</FormMessage>
      </form>
    </Sheet>
  );
}

/**
 * "Remove" asks first: a team that never locked is deleted, one that has
 * locked is retired and leaves every league (DM 3.6). Give it
 * `key={team?.id}`, so each team starts afresh.
 */
export function RemoveTeamSheet({
  team,
  onClose,
  remove,
  onDone,
}: {
  team: TeamSummary | null;
  onClose: () => void;
  remove: (teamId: string) => Promise<Result>;
  onDone: () => Promise<void>;
}) {
  const [message, setMessage] = useState<string>();
  const [working, setWorking] = useState(false);

  async function confirm() {
    if (!team || working) return;
    setMessage(undefined);
    setWorking(true);
    const error = await attempt(() => remove(team.id));
    if (error) {
      setWorking(false);
      setMessage(error);
      return;
    }
    await onDone();
  }

  const retire = team?.locked ?? false;
  return (
    <Sheet
      open={team !== null}
      onClose={onClose}
      title={retire ? "Retire this team?" : "Delete this team?"}
      actions={
        <Button block disabled={working} onClick={confirm}>
          {retire ? "Retire" : "Delete"}
        </Button>
      }
    >
      <p className="m-0 text-[16px] leading-[22px] text-ink-muted">
        {retire
          ? `${team?.name ?? "It"} leaves every league. Its past points stay, and its slot stays taken.`
          : `${team?.name ?? "It"} and its picks are deleted, and its slot is free again.`}
      </p>
      <FormMessage>{message}</FormMessage>
    </Sheet>
  );
}
