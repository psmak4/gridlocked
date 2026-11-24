/**
 * The nightly dump (M9 Task 11, decision 4), run by
 * `.github/workflows/backup.yml`:
 *
 *   DATABASE_URL=postgres://… pnpm backup-dump <out.dump> <out.counts.tsv>
 *   DATABASE_URL=postgres://… pnpm backup-dump --counts-only <out.counts.tsv>
 *
 * The second counts a database without dumping it: the restore drill counts
 * what it restored, to diff against the backup's counts.
 *
 * It opens a read-only repeatable-read transaction and exports its snapshot,
 * runs `pg_dump --format=custom --snapshot=…` in that snapshot, then counts
 * every table's rows in the same transaction. So the counts are exactly the
 * dump's, and the restore drill can match them row for row. The counts file
 * holds table names and numbers only.
 *
 * The pooler's host is swapped for the direct one: pg_dump needs a session
 * of its own on the same compute. The URL goes to pg_dump as an argument and
 * is never printed.
 */
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Pool } from "@neondatabase/serverless";

/**
 * The schemas counted: the app's, and the migrations' ledger. The dump is the
 * whole database, not these alone: naming schemas would leave out the
 * extensions the migrations create (btree_gist, ltree).
 */
export const BACKUP_SCHEMAS = ["public", "drizzle"] as const;

/** A Neon URL's direct host: `ep-x-pooler.region…` becomes `ep-x.region…`. */
export function directUrl(url: string): string {
  const parsed = new URL(url);
  parsed.hostname = parsed.hostname.replace(/-pooler(?=\.)/, "");
  return parsed.toString();
}

type Query = (text: string) => Promise<{ rows: Record<string, unknown>[] }>;

const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** `schema.table<TAB>rows`, one line per table, sorted: in the caller's transaction. */
export async function countRows(query: Query): Promise<string> {
  const schemas = BACKUP_SCHEMAS.map((s) => `'${s}'`).join(", ");
  const { rows: tables } = await query(
    `select table_schema, table_name from information_schema.tables
     where table_schema in (${schemas}) and table_type = 'BASE TABLE'
     order by table_schema, table_name`,
  );
  const lines: string[] = [];
  for (const t of tables) {
    const schema = String(t.table_schema);
    const table = String(t.table_name);
    const { rows } = await query(
      `select count(*)::text as n from ${quoteIdent(schema)}.${quoteIdent(table)}`,
    );
    lines.push(`${schema}.${table}\t${String(rows[0]!.n)}`);
  }
  return lines.join("\n") + "\n";
}

function pgDump(url: string, snapshot: string, out: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(
      "pg_dump",
      [
        "--format=custom",
        `--snapshot=${snapshot}`,
        "--no-owner",
        "--no-privileges",
        `--file=${out}`,
        `--dbname=${url}`,
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

async function countOnly(url: string, countsPath: string): Promise<number> {
  const pool = new Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("begin isolation level repeatable read read only");
    const counts = await countRows((text) => client.query(text));
    await client.query("commit");
    await writeFile(countsPath, counts);
    console.log(
      `backup-dump: ${counts.trim().split("\n").length} tables counted`,
    );
    return 0;
  } finally {
    client.release();
    await pool.end();
  }
}

async function main(args: string[]): Promise<number> {
  const url = process.env.DATABASE_URL;
  if (args[0] === "--counts-only") {
    if (!args[1] || !url) {
      console.error(
        "usage: DATABASE_URL=… backup-dump --counts-only <out.counts.tsv>",
      );
      return 1;
    }
    return countOnly(url, args[1]);
  }
  const [dumpPath, countsPath] = args;
  if (!dumpPath || !countsPath || !url) {
    console.error(
      "usage: DATABASE_URL=… backup-dump <out.dump> <out.counts.tsv>",
    );
    return 1;
  }
  const direct = directUrl(url);
  const pool = new Pool({ connectionString: direct, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("begin isolation level repeatable read read only");
    const { rows } = await client.query<{ id: string }>(
      "select pg_export_snapshot() as id",
    );
    const code = await pgDump(direct, rows[0]!.id, dumpPath);
    if (code !== 0) {
      console.error(`backup-dump: pg_dump exited ${code}`);
      return 1;
    }
    const counts = await countRows((text) => client.query(text));
    await client.query("commit");
    await writeFile(countsPath, counts);
    console.log(
      `backup-dump: ${counts.trim().split("\n").length} tables dumped and counted`,
    );
    return 0;
  } finally {
    client.release();
    await pool.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main(process.argv.slice(2));
}
