/**
 * Checks for the nightly backup (M9 Task 11, decision 4), run by
 * `.github/workflows/backup.yml` and by hand in the restore drill
 * (`docs/runbooks/restore.md`):
 *
 *   pnpm backup-check dump <file.dump>            the dump is whole
 *   pnpm backup-check encrypted <file.age> <file.dump>
 *   pnpm backup-check prune <keep> < keys          the keys to delete
 *   pnpm backup-check diff <backup.tsv> <restored.tsv>
 *
 * A custom-format dump has no end marker of its own, and a cut-short one
 * still lists its table of contents. So the dump is rendered back to SQL
 * with `pg_restore` (to nowhere but the last few KB), and the script's
 * closing line must be there. Any problem prints one line each and exits 1,
 * which fails the run. Nothing here reads or prints a row.
 */
import { spawn } from "node:child_process";
import { open, readFile, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";

/** No real dump of the schema alone is this small. */
export const BACKUP_MIN_BYTES = 32 * 1024;

const PGDMP = "PGDMP";
const AGE = "age-encryption.org/v1\n";
const CLOSING = "-- PostgreSQL database dump complete";

/** Problems with a dump: its first bytes, its size, and the end of its SQL. */
export function checkDump(dump: {
  header: Buffer;
  size: number;
  scriptTail: string;
}): string[] {
  const problems: string[] = [];
  if (dump.header.subarray(0, PGDMP.length).toString("latin1") !== PGDMP) {
    problems.push("not a pg_dump custom-format archive");
  }
  if (dump.size < BACKUP_MIN_BYTES) {
    problems.push(
      `${dump.size} bytes is under the ${BACKUP_MIN_BYTES}-byte floor`,
    );
  }
  if (problems.length === 0 && !dump.scriptTail.includes(CLOSING)) {
    problems.push(
      "no closing marker: pg_restore didn't reach the end of the dump",
    );
  }
  return problems;
}

/** Problems with the encrypted copy: age's header, and no shorter than its dump. */
export function checkEncrypted(file: {
  header: Buffer;
  size: number;
  plainSize: number;
}): string[] {
  if (file.header.subarray(0, AGE.length).toString("latin1") !== AGE) {
    return ["not age-encrypted"];
  }
  if (file.size <= file.plainSize) {
    return [`${file.size} bytes encrypted from ${file.plainSize}: cut short`];
  }
  return [];
}

const BACKUP_KEY = /\/\d{4}-\d{2}-\d{2}\.dump\.age$/;

/** The backups past the newest `keep`, oldest first. Dated names sort by date. */
export function toPrune(keys: string[], keep: number): string[] {
  const backups = keys.filter((k) => BACKUP_KEY.test(k)).sort();
  return backups.slice(0, Math.max(0, backups.length - keep));
}

/** `table<TAB>count` lines, as `backup-dump` writes them. */
export function parseCounts(tsv: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of tsv.split("\n")) {
    const [table, n] = line.split("\t");
    if (table && n !== undefined) counts.set(table, Number(n));
  }
  return counts;
}

/** One line per table whose restored count isn't the backup's. */
export function diffCounts(
  backup: Map<string, number>,
  restored: Map<string, number>,
): string[] {
  const problems: string[] = [];
  for (const [table, n] of [...backup].sort(([a], [b]) => a.localeCompare(b))) {
    const got = restored.get(table);
    if (got !== n) {
      problems.push(
        `${table}: ${n} in the backup, ${got === undefined ? "missing" : got} restored`,
      );
    }
  }
  return problems;
}

async function head(path: string, bytes: number): Promise<Buffer> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await file.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

/** The last few KB of `pg_restore --file=-`, or "" if it failed. */
function restoredTail(path: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("pg_restore", ["--file=-", path], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let tail = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      tail = (tail + chunk).slice(-4096);
    });
    child.on("error", () => resolve(""));
    child.on("close", (code) => resolve(code === 0 ? tail : ""));
  });
}

async function readStdin(): Promise<string> {
  let text = "";
  for await (const chunk of process.stdin) text += String(chunk);
  return text;
}

async function main(args: string[]): Promise<number> {
  const [command, a, b] = args;
  let problems: string[];
  switch (command) {
    case "dump": {
      problems = checkDump({
        header: await head(a!, 8),
        size: (await stat(a!)).size,
        scriptTail: await restoredTail(a!),
      });
      break;
    }
    case "encrypted": {
      problems = checkEncrypted({
        header: await head(a!, 64),
        size: (await stat(a!)).size,
        plainSize: (await stat(b!)).size,
      });
      break;
    }
    case "prune": {
      const keep = Number(a);
      if (!Number.isInteger(keep) || keep < 1) {
        console.error("prune: keep must be a whole number of copies");
        return 1;
      }
      for (const key of toPrune((await readStdin()).split("\n"), keep)) {
        console.log(key);
      }
      return 0;
    }
    case "diff": {
      problems = diffCounts(
        parseCounts(await readFile(a!, "utf8")),
        parseCounts(await readFile(b!, "utf8")),
      );
      break;
    }
    default:
      console.error("usage: backup-check dump|encrypted|prune|diff …");
      return 1;
  }
  for (const problem of problems) console.error(`backup-check: ${problem}`);
  if (problems.length === 0) console.log(`backup-check: ${command} ok`);
  return problems.length === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2));
}
