import { createFileRoute, notFound } from "@tanstack/react-router";
import { cacheControl } from "@/spike/cache";
import { getRaceResults } from "@/spike/server-fns";

export const Route = createFileRoute("/results/$round")({
  loader: async ({ params }) => {
    const round = Number(params.round);
    if (!Number.isInteger(round) || round < 1 || round > 23) throw notFound();
    return { round, rows: await getRaceResults({ data: { round } }) };
  },
  headers: () => ({ "Cache-Control": cacheControl("public-page") }),
  head: ({ loaderData }) => ({
    meta: [
      { title: `Round ${loaderData?.round} results · Gridlocked` },
      {
        name: "description",
        content: `The 2026 round ${loaderData?.round} race classification.`,
      },
    ],
  }),
  component: Results,
});

function Results() {
  const { round, rows } = Route.useLoaderData();
  return (
    <main className="p-space-4">
      <h1 className="font-display text-[32px] uppercase">Round {round}</h1>
      <ol>
        {rows.map((r) => (
          <li key={r.driverId}>
            {r.position ?? r.classification.toUpperCase()} · #{r.carNumber}{" "}
            {r.name}
          </li>
        ))}
      </ol>
    </main>
  );
}
