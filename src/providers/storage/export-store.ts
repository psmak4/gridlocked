/**
 * The production `ExportStore` (DM 6.7): the `exports` bucket in Neon Object
 * Storage, declared in neon.ts. Neon injects the same AWS_* variables as for
 * the `scheduler` bucket, so the client is `createS3ClientFromEnv`'s
 * (path-style, checksums only when required). Download links are SigV4
 * presigned GETs.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ExportStore } from "@/identity/export";
import { createS3ClientFromEnv } from "./due-store";

export const EXPORT_BUCKET = "exports";

/** What the file is called when the browser saves it. */
const DOWNLOAD_NAME = 'attachment; filename="gridlocked-data-export.json"';

export function createExportStore(
  client: S3Client,
  bucket: string = EXPORT_BUCKET,
): ExportStore {
  return {
    async put(key, body) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: "application/json",
        }),
      );
    },
    presign(key, seconds) {
      return getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          ResponseContentDisposition: DOWNLOAD_NAME,
        }),
        { expiresIn: seconds },
      );
    },
    async delete(key) {
      // S3 answers a delete of a missing key with success.
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}

export function createExportStoreFromEnv(
  env: Record<string, string | undefined>,
): ExportStore {
  return createExportStore(createS3ClientFromEnv(env));
}

/** An in-memory `ExportStore` that records what it was asked, for tests. */
export function createMemoryExportStore() {
  const objects = new Map<string, string>();
  const puts: { key: string; body: string }[] = [];
  const presigned: { key: string; seconds: number }[] = [];
  const deleted: string[] = [];
  const store: ExportStore = {
    async put(key, body) {
      puts.push({ key, body });
      objects.set(key, body);
    },
    async presign(key, seconds) {
      presigned.push({ key, seconds });
      return `https://exports.memory.test/${key}?expires=${seconds}`;
    },
    async delete(key) {
      deleted.push(key);
      objects.delete(key);
    },
  };
  return { store, objects, puts, presigned, deleted };
}
