import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return (
    <main className="p-space-4">
      <h1 className="font-display text-[32px] uppercase">GRIDLOCKED</h1>
      <p>Coming for the 2027 season.</p>
    </main>
  );
}
