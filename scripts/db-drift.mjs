// Fails when src/db/schema and src/db/migrations disagree.
//
// `drizzle-kit check` only checks migration history, so this regenerates and
// looks for changes. drizzle-kit exits 0 even when it can't finish (a rename
// needs an interactive prompt, which fails without a TTY), so its output is
// checked for errors too.
import { spawnSync } from "node:child_process";

const MIGRATIONS = "src/db/migrations";

const generate = spawnSync("drizzle-kit", ["generate"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  shell: process.platform === "win32",
});
const output = `${generate.stdout ?? ""}${generate.stderr ?? ""}`;
process.stdout.write(output);

if (generate.status !== 0 || /^\s*Error\b/m.test(output)) {
  console.error(
    "\ndb:drift: drizzle-kit generate did not finish. If you renamed a column or table, run `pnpm db:generate` in a terminal and answer its prompt.",
  );
  process.exit(1);
}

const status = spawnSync("git", ["status", "--porcelain", "--", MIGRATIONS], {
  encoding: "utf8",
});
if (status.status !== 0) {
  process.stderr.write(status.stderr ?? "");
  process.exit(1);
}
if (status.stdout.trim() !== "") {
  console.error(
    `\ndb:drift: the schema has changes with no migration. Run \`pnpm db:generate\` and commit ${MIGRATIONS}/.\n${status.stdout}`,
  );
  process.exit(1);
}
