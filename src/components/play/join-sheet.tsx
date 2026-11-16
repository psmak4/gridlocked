import { useState, type FormEvent } from "react";
import { selectClass } from "@/components/account-layout";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { TextField } from "@/components/ui/text-field";
import type { GameErrorCode } from "@/game/errors";
import { leagueRefusalWords } from "./league-words";

export type JoinResult =
  | { ok: true; slug: string; name: string }
  | { ok: false; error: GameErrorCode };

type JoinSheetProps = {
  open: boolean;
  onClose: () => void;
  /** The viewer's active teams; with more than one, they choose. */
  teams: Array<{ id: string; name: string }>;
  join: (data: { code: string; teamId: string }) => Promise<JoinResult>;
  /** After a join: the league's name, for the toast. */
  onJoined: (name: string) => Promise<void>;
};

/**
 * "Join with a code" (wave 3): the code, then which team, when there's more
 * than one. The code never goes in an address, so it doesn't reach logs.
 */
export function JoinSheet({
  open,
  onClose,
  teams,
  join,
  onJoined,
}: JoinSheetProps) {
  const [code, setCode] = useState("");
  const [teamId, setTeamId] = useState(teams[0]?.id ?? "");
  const [message, setMessage] = useState<string>();
  const [working, setWorking] = useState(false);

  const close = () => {
    setCode("");
    setMessage(undefined);
    onClose();
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (working) return;
    setWorking(true);
    setMessage(undefined);
    try {
      const result = await join({ code, teamId });
      if (result.ok) {
        setCode("");
        await onJoined(result.name);
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
    <Sheet open={open} onClose={close} title="Join a league">
      <form
        id="join-league"
        onSubmit={(e) => void submit(e)}
        className="flex flex-col gap-space-3"
      >
        <TextField
          id="join-code"
          label="League code"
          hint="10 letters and numbers, from the invite."
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          error={message}
          required
        />
        {teams.length > 1 ? (
          <div className="flex flex-col gap-[6px]">
            <label htmlFor="join-team" className="text-[14px] font-bold">
              Which of your teams joins
            </label>
            <select
              id="join-team"
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
        <Button type="submit" size="l" block disabled={working}>
          {working ? "Joining…" : "Join league"}
        </Button>
      </form>
    </Sheet>
  );
}
