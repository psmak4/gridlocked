import { describe, expect, it } from "vitest";
import {
  BACKUP_MIN_BYTES,
  checkDump,
  checkEncrypted,
  diffCounts,
  parseCounts,
  toPrune,
} from "./backup-check";

// M9 Task 11: a nightly backup is checked before it's kept. A dump is a
// custom-format archive that pg_restore renders to the end; the stored copy
// is age-encrypted; 14 copies are kept; a restore's row counts match the
// counts taken in the dump's own snapshot.

const PGDMP = Buffer.from("PGDMP\x01\x10\x00", "binary");
const COMPLETE = "\n--\n-- PostgreSQL database dump complete\n--\n\n";

describe("checkDump", () => {
  const good = {
    header: PGDMP,
    size: BACKUP_MIN_BYTES + 1,
    scriptTail: `ALTER TABLE ONLY public.users ...;${COMPLETE}`,
  };

  it("passes a whole custom-format dump over the floor", () => {
    expect(checkDump(good)).toEqual([]);
  });

  it("backup-check refuses a dump with no closing marker, one under the size floor, or one that isn't age-encrypted", () => {
    expect(
      checkDump({
        ...good,
        scriptTail: "COPY public.posts (id, body) FROM stdin;\n",
      }),
    ).toEqual([
      "no closing marker: pg_restore didn't reach the end of the dump",
    ]);
    expect(checkDump({ ...good, size: 1_024 })).toEqual([
      `1024 bytes is under the ${BACKUP_MIN_BYTES}-byte floor`,
    ]);
    expect(
      checkEncrypted({
        header: PGDMP,
        size: BACKUP_MIN_BYTES * 2,
        plainSize: BACKUP_MIN_BYTES * 2,
      }),
    ).toEqual(["not age-encrypted"]);
  });

  it("refuses a file that isn't a custom-format archive", () => {
    expect(
      checkDump({ ...good, header: Buffer.from("-- PostgreSQL") }),
    ).toEqual(["not a pg_dump custom-format archive"]);
  });
});

describe("checkEncrypted", () => {
  const AGE = Buffer.from("age-encryption.org/v1\n-> X25519 abc\n");

  it("passes an age file a little larger than its dump", () => {
    expect(
      checkEncrypted({ header: AGE, size: 200_100, plainSize: 200_000 }),
    ).toEqual([]);
  });

  it("refuses an age file smaller than its dump: it was cut short", () => {
    expect(
      checkEncrypted({ header: AGE, size: 100_000, plainSize: 200_000 }),
    ).toEqual(["100000 bytes encrypted from 200000: cut short"]);
  });
});

describe("toPrune", () => {
  const day = (d: number) =>
    `staging/2026-11-${String(d).padStart(2, "0")}.dump.age`;

  it("keeps the newest 14 copies and names the rest", () => {
    const keys = Array.from({ length: 17 }, (_, i) => day(i + 1)).reverse();
    expect(toPrune(keys, 14)).toEqual([day(1), day(2), day(3)]);
  });

  it("names nothing with 14 or fewer, and ignores files that aren't backups", () => {
    const keys = [
      day(1),
      day(2),
      "staging/notes.txt",
      "staging/2026-11-03.counts.tsv",
    ];
    expect(toPrune(keys, 14)).toEqual([]);
  });
});

describe("the restore's row counts", () => {
  const source = "jobs\t12\nposts\t40\nusers\t7\n";

  it("match when every table has the same count", () => {
    expect(diffCounts(parseCounts(source), parseCounts(source))).toEqual([]);
  });

  it("names each table that differs or is missing", () => {
    const restored = "jobs\t12\nposts\t39\n";
    expect(diffCounts(parseCounts(source), parseCounts(restored))).toEqual([
      "posts: 40 in the backup, 39 restored",
      "users: 7 in the backup, missing restored",
    ]);
  });
});
