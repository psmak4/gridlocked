/**
 * The daily community job (`community_daily`, queued once a UTC day by
 * `sync_calendar`, after `identity_daily`). Like the identity job it runs a
 * named list of steps, each in its own try, then throws if any failed so the
 * runner retries the whole job; every step is safe to run again.
 *
 * M7 Task 9 brings the chat archive; Task 15 adds reputation, trust inputs,
 * hot rank and retention.
 */
import type { Db } from "@/db/types";
import type { JobHandler } from "@/jobs/runner";
import {
  archiveDueChats,
  unconfiguredChatArchiveStore,
  type ChatArchiveStore,
} from "./archive";

type Step = (db: Db, now: Date) => Promise<string>;

export const COMMUNITY_DAILY_STEPS = ["archiveChats"] as const;
export type CommunityDailyStep = (typeof COMMUNITY_DAILY_STEPS)[number];

const defaultSteps = (
  store: ChatArchiveStore,
): Record<CommunityDailyStep, Step> => ({
  archiveChats: async (db, now) => {
    const archived = await archiveDueChats(db, store, now);
    return `archived=${archived}`;
  },
});

/**
 * `chatArchives` is the `chat-archives` bucket; without one, `archiveChats`
 * only fails if there is a chat to archive.
 */
export function createCommunityDailyHandler({
  log = console.log,
  steps = {},
  chatArchives = unconfiguredChatArchiveStore,
}: {
  log?: (line: string) => void;
  steps?: Partial<Record<CommunityDailyStep, Step>>;
  chatArchives?: ChatArchiveStore;
} = {}): JobHandler {
  const defaults = defaultSteps(chatArchives);
  return async (_job, ctx) => {
    const db = ctx.db as unknown as Db;
    const now = ctx.clock.now();
    const failed: string[] = [];
    for (const name of COMMUNITY_DAILY_STEPS) {
      const step = steps[name] ?? defaults[name];
      try {
        log(`community_daily: ${name} ${await step(db, now)}`);
      } catch (error) {
        failed.push(name);
        const kind = error instanceof Error ? error.name : "unknown";
        log(`community_daily: ${name} failed (${kind})`);
      }
    }
    if (failed.length > 0) {
      throw new Error(`community_daily: ${failed.join(", ")} failed`);
    }
  };
}
