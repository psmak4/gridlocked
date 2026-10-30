import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { cacheControl } from "@/spike/cache";
import type { Pick } from "@/spike/picks";
import { getPicks, getRaceResults, makePick } from "@/spike/server-fns";

const ROUND = 19;

export const Route = createFileRoute("/picks")({
  // The drivers to choose from: round 18's finishers.
  loader: () => getRaceResults({ data: { round: 18 } }),
  headers: () => ({ "Cache-Control": cacheControl("private") }),
  head: () => ({ meta: [{ title: "Your pick · Gridlocked" }] }),
  component: Picks,
});

function Picks() {
  const drivers = Route.useLoaderData();
  const queryClient = useQueryClient();
  const fetchPicks = useServerFn(getPicks);
  const sendPick = useServerFn(makePick);
  const picks = useQuery({ queryKey: ["picks"], queryFn: () => fetchPicks() });

  const pick = useMutation({
    mutationFn: (driverId: string) =>
      sendPick({ data: { round: ROUND, driverId } }),
    // Show the choice at once; put the old list back if the server says no.
    onMutate: async (driverId) => {
      await queryClient.cancelQueries({ queryKey: ["picks"] });
      const before = queryClient.getQueryData<Pick[]>(["picks"]);
      queryClient.setQueryData<Pick[]>(["picks"], (old = []) => [
        ...old.filter((p) => p.round !== ROUND),
        { round: ROUND, driverId },
      ]);
      return { before };
    },
    onError: (_error, _driverId, context) => {
      queryClient.setQueryData(["picks"], context?.before);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["picks"] }),
  });

  const chosen = picks.data?.find((p) => p.round === ROUND)?.driverId;
  return (
    <main className="p-space-4">
      <h1 className="font-display text-[32px] uppercase">Round {ROUND} pick</h1>
      <ul>
        {drivers.map((d) => (
          <li key={d.driverId}>
            <button
              type="button"
              aria-pressed={chosen === d.driverId}
              onClick={() => pick.mutate(d.driverId)}
            >
              {chosen === d.driverId ? "✓ " : ""}
              {d.name}
            </button>
          </li>
        ))}
      </ul>
      {pick.isError ? <p role="alert">That pick didn't save.</p> : null}
    </main>
  );
}
