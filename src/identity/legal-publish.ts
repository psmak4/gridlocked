/**
 * Publishes a legal document's approved text in one environment (M9 Task 13),
 * dated at that environment's "now": on a replay database that's the replay
 * clock, so the document is in force there at once. Run by
 * `scripts/publish-legal.ts`.
 */
import type { Db } from "@/db/types";
import {
  resolveClock,
  type ClockDb,
  type ClockMode,
} from "@/lib/resolve-clock";
import { publishDocument } from "./consent";
import { PUBLISHABLE } from "./legal-text";

export async function publishLegal(
  db: Db & ClockDb,
  mode: ClockMode,
  kind: string,
): Promise<{ published: boolean; version: string; at: Date }> {
  if (!Object.hasOwn(PUBLISHABLE, kind)) {
    throw new Error(`no text to publish for "${kind}"`);
  }
  const doc = PUBLISHABLE[kind as keyof typeof PUBLISHABLE];
  const at = (await resolveClock({ mode, db })).now();
  const published = await publishDocument(db, at, doc);
  return { published, version: doc.version, at };
}
