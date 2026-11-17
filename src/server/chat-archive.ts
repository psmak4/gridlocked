/**
 * The website's read of the `chat-archives` bucket, for the thread page's
 * replay (DM 5.5). A local build (`VITE_LOCAL_DB=1`) keeps archives in
 * memory, shared with its in-process jobs; a deployed one reads the bucket
 * through the CHAT_ARCHIVE_S3_* variables, and without them has no store,
 * so the replay says it can't be shown. The flag is replaced at build time.
 *
 * The one file in src/server that wires a storage adapter (eslint.config.mjs).
 */
import type { ChatArchiveStore } from "@/community/archive";
import { webChatArchiveStoreFromEnv } from "@/providers/storage/chat-archive-store";

let cached: ChatArchiveStore | null | undefined;

export async function webChatArchiveStore(): Promise<ChatArchiveStore | null> {
  if (import.meta.env.VITE_LOCAL_DB === "1") {
    return import("./local-db").then((m) => m.localChatArchiveStore);
  }
  cached ??= webChatArchiveStoreFromEnv(process.env);
  return cached;
}
