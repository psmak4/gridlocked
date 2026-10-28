import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { rawSnapshots } from "@/db/schema";
import type { Db } from "@/db/types";
import { newId } from "@/lib/ids";

/**
 * JSON with object keys sorted at every level, so two bodies that differ only
 * in key order serialize identically. Array order is kept. Like
 * `JSON.stringify`, it drops `undefined` object values.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortKeys(source[key]);
    }
    return sorted;
  }
  return value;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Hash of `(provider, endpoint, params)`: "the same question" (DM 2.2). */
export function hashParams(
  provider: string,
  endpoint: string,
  params: Record<string, string>,
): string {
  return sha256(canonicalJson({ provider, endpoint, params }));
}

export interface SnapshotInput {
  provider: string;
  endpoint: string;
  params: Record<string, string>;
  body: unknown;
  now: Date;
  seasonId?: string | null;
  eventId?: string | null;
  sessionId?: string | null;
}

/**
 * Stores a provider response (DM 2.2). The same answer to the same question
 * is stored once: a refetch with the same content only moves `last_seen_at`.
 * `changed` is true only when this call inserted a new snapshot.
 */
export async function storeSnapshot(
  db: Db,
  s: SnapshotInput,
): Promise<{ id: string; changed: boolean }> {
  const canonicalBody = canonicalJson(s.body);
  const [row] = await db
    .insert(rawSnapshots)
    .values({
      id: newId(),
      provider: s.provider,
      endpoint: s.endpoint,
      paramsHash: hashParams(s.provider, s.endpoint, s.params),
      contentHash: sha256(canonicalBody),
      body: s.body,
      bodyBytes: Buffer.byteLength(canonicalBody, "utf8"),
      firstFetchedAt: s.now,
      lastSeenAt: s.now,
      seasonId: s.seasonId ?? null,
      eventId: s.eventId ?? null,
      sessionId: s.sessionId ?? null,
    })
    .onConflictDoUpdate({
      target: [rawSnapshots.paramsHash, rawSnapshots.contentHash],
      set: { lastSeenAt: s.now },
    })
    // xmax is 0 on a freshly inserted row and set on one the upsert updated.
    .returning({
      id: rawSnapshots.id,
      inserted: sql<boolean>`(xmax = 0)`,
    });

  if (!row) throw new Error("storeSnapshot: upsert returned no row");
  return { id: row.id, changed: row.inserted };
}
