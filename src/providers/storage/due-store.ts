/**
 * The production `DueStore`: an S3 client against Neon Object Storage (bucket
 * `scheduler`, key `due-times.json`; M1 result). The function gets
 * `AWS_ENDPOINT_URL_S3`, `AWS_REGION`, `AWS_ACCESS_KEY_ID` and
 * `AWS_SECRET_ACCESS_KEY` injected.
 */
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
} from "@aws-sdk/client-s3";
import { DUE_BUCKET, type DueStore } from "@/jobs/due-times";

/** The part of `S3Client` the store uses, so tests can stub `send`. */
export type S3Sender = {
  send(command: GetObjectCommand | PutObjectCommand): Promise<unknown>;
};

function isMissingObject(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { name, $metadata } = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
  };
  return name === "NoSuchKey" || $metadata?.httpStatusCode === 404;
}

export function createDueStore(
  client: S3Sender,
  bucket: string = DUE_BUCKET,
): DueStore {
  return {
    async get(key) {
      try {
        const out = (await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: key }),
        )) as GetObjectCommandOutput;
        if (!out.Body)
          throw new Error(`S3 object ${bucket}/${key} has no body`);
        return await out.Body.transformToString();
      } catch (error) {
        if (isMissingObject(error)) return null;
        throw error;
      }
    },
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
  };
}

const REQUIRED_ENV = [
  "AWS_ENDPOINT_URL_S3",
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
] as const;

/**
 * Path-style addressing is required by Neon Object Storage, which has no
 * per-bucket hostnames.
 */
export function createS3ClientFromEnv(
  env: Record<string, string | undefined>,
): S3Client {
  for (const name of REQUIRED_ENV) {
    if (!env[name]) throw new Error(`Missing environment variable ${name}`);
  }
  return new S3Client({
    endpoint: env.AWS_ENDPOINT_URL_S3,
    region: env.AWS_REGION,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY!,
    },
    forcePathStyle: true,
    // S3-compatible stores can reject the SDK v3 default checksum headers.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

export function createDueStoreFromEnv(
  env: Record<string, string | undefined>,
): DueStore {
  return createDueStore(createS3ClientFromEnv(env));
}
