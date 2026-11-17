/**
 * The production `ChatArchiveStore` (DM 5.5, M7 decision 5): the
 * `chat-archives` bucket in Neon Object Storage, declared in neon.ts. Archives
 * keep for good, so they have a bucket of their own, apart from `exports`.
 *
 * The tick function gets the bucket's keys from Neon (the AWS_* variables, as
 * for `scheduler` and `exports`). The website reads archives for the replay,
 * and Vercel reserves the AWS_* names, so there it uses CHAT_ARCHIVE_S3_*
 * variables the owner sets; without them the replay says it can't be shown.
 */
import {
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import type { ChatArchiveStore } from "@/community/archive";
import { createS3ClientFromEnv } from "./due-store";

export const CHAT_ARCHIVE_BUCKET = "chat-archives";

export function createChatArchiveStore(
  client: S3Client,
  bucket: string = CHAT_ARCHIVE_BUCKET,
): ChatArchiveStore {
  return {
    async put(key, body) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: "application/gzip",
        }),
      );
    },
    async get(key) {
      try {
        const out = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: key }),
        );
        return out.Body ? await out.Body.transformToByteArray() : null;
      } catch (error) {
        if (error instanceof NoSuchKey) return null;
        throw error;
      }
    },
  };
}

/** The tick's: Neon's injected AWS_* variables. */
export function createChatArchiveStoreFromEnv(
  env: Record<string, string | undefined>,
): ChatArchiveStore {
  return createChatArchiveStore(createS3ClientFromEnv(env));
}

/** The website's read-only names (Vercel reserves AWS_*). */
const WEB_ENV = {
  AWS_ENDPOINT_URL_S3: "CHAT_ARCHIVE_S3_ENDPOINT",
  AWS_REGION: "CHAT_ARCHIVE_S3_REGION",
  AWS_ACCESS_KEY_ID: "CHAT_ARCHIVE_S3_ACCESS_KEY_ID",
  AWS_SECRET_ACCESS_KEY: "CHAT_ARCHIVE_S3_SECRET_ACCESS_KEY",
} as const;

/** The website's store, or null until all four CHAT_ARCHIVE_S3_* are set. */
export function webChatArchiveStoreFromEnv(
  env: Record<string, string | undefined>,
): ChatArchiveStore | null {
  const mapped: Record<string, string | undefined> = {};
  for (const [aws, ours] of Object.entries(WEB_ENV)) {
    const value = env[ours];
    if (!value) return null;
    mapped[aws] = value;
  }
  return createChatArchiveStore(createS3ClientFromEnv(mapped));
}

/** An in-memory `ChatArchiveStore` that records what it was asked, for tests. */
export function createMemoryChatArchiveStore() {
  const objects = new Map<string, Uint8Array>();
  const puts: string[] = [];
  const store: ChatArchiveStore = {
    async put(key, body) {
      puts.push(key);
      objects.set(key, body);
    },
    async get(key) {
      return objects.get(key) ?? null;
    },
  };
  return { store, objects, puts };
}
