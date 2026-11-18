import {
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { createS3ClientFromEnv } from "./due-store";
import {
  CHAT_ARCHIVE_BUCKET,
  createChatArchiveStore,
  webChatArchiveStoreFromEnv,
} from "./chat-archive-store";

// Fake values only: nothing is sent.
const env = {
  AWS_ENDPOINT_URL_S3: "https://storage.example.invalid",
  AWS_REGION: "aws-us-east-1",
  AWS_ACCESS_KEY_ID: "test-key-id",
  AWS_SECRET_ACCESS_KEY: "test-secret",
};

describe("createChatArchiveStore", () => {
  it("writes gzip to the chat-archives bucket", async () => {
    const client = createS3ClientFromEnv(env);
    const send = vi.spyOn(client, "send").mockResolvedValue({} as never);
    const body = new Uint8Array([1, 2, 3]);
    await createChatArchiveStore(client).put("chat/t1.jsonl.gz", body);
    const [put] = send.mock.calls.map((call) => call[0]);
    expect(CHAT_ARCHIVE_BUCKET).toBe("chat-archives");
    expect(put).toBeInstanceOf(PutObjectCommand);
    expect((put as PutObjectCommand).input).toEqual({
      Bucket: "chat-archives",
      Key: "chat/t1.jsonl.gz",
      Body: body,
      ContentType: "application/gzip",
    });
  });

  it("reads a file back, and a missing one as null", async () => {
    const client = createS3ClientFromEnv(env);
    const send = vi
      .spyOn(client, "send")
      .mockResolvedValueOnce({
        Body: { transformToByteArray: async () => new Uint8Array([9]) },
      } as never)
      .mockRejectedValueOnce(
        new NoSuchKey({ message: "missing", $metadata: {} }),
      );
    const store = createChatArchiveStore(client);
    expect(await store.get("chat/t1.jsonl.gz")).toEqual(new Uint8Array([9]));
    expect(await store.get("chat/t2.jsonl.gz")).toBeNull();
    expect(send.mock.calls[0]![0]).toBeInstanceOf(GetObjectCommand);
  });

  it("the website has no store until all four CHAT_ARCHIVE_S3_* are set", () => {
    const web = {
      CHAT_ARCHIVE_S3_ENDPOINT: "https://storage.example.invalid",
      CHAT_ARCHIVE_S3_REGION: "aws-us-east-1",
      CHAT_ARCHIVE_S3_ACCESS_KEY_ID: "test-key-id",
      CHAT_ARCHIVE_S3_SECRET_ACCESS_KEY: "test-secret",
    };
    expect(webChatArchiveStoreFromEnv(env)).toBeNull();
    expect(
      webChatArchiveStoreFromEnv({ ...web, CHAT_ARCHIVE_S3_REGION: "" }),
    ).toBeNull();
    expect(webChatArchiveStoreFromEnv(web)).not.toBeNull();
  });
});
