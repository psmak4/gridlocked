import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { createDueStore, createS3ClientFromEnv } from "./due-store";

function stubClient(send: (command: unknown) => unknown) {
  return { send: vi.fn(async (command: unknown) => send(command)) };
}

const awsError = (name: string, status: number) =>
  Object.assign(new Error(name), {
    name,
    $metadata: { httpStatusCode: status },
  });

describe("createDueStore", () => {
  it("reads an object as text from the bucket", async () => {
    const client = stubClient(() => ({
      Body: { transformToString: async () => '{"hello":1}' },
    }));
    const store = createDueStore(client, "scheduler");

    expect(await store.get("due-times.json")).toBe('{"hello":1}');
    const command = client.send.mock.calls[0]![0] as GetObjectCommand;
    expect(command).toBeInstanceOf(GetObjectCommand);
    expect(command.input).toEqual({
      Bucket: "scheduler",
      Key: "due-times.json",
    });
  });

  it("returns null for NoSuchKey", async () => {
    const store = createDueStore(
      stubClient(() => {
        throw awsError("NoSuchKey", 404);
      }),
      "scheduler",
    );
    expect(await store.get("due-times.json")).toBeNull();
  });

  it("returns null for a bare 404", async () => {
    const store = createDueStore(
      stubClient(() => {
        throw awsError("UnknownError", 404);
      }),
      "scheduler",
    );
    expect(await store.get("due-times.json")).toBeNull();
  });

  it("rethrows other errors, so a 5xx or a denied request is not read as 'missing'", async () => {
    const forbidden = createDueStore(
      stubClient(() => {
        throw awsError("AccessDenied", 403);
      }),
      "scheduler",
    );
    await expect(forbidden.get("due-times.json")).rejects.toThrow(
      "AccessDenied",
    );

    const broken = createDueStore(
      stubClient(() => {
        throw new Error("socket hang up");
      }),
      "scheduler",
    );
    await expect(broken.get("due-times.json")).rejects.toThrow(
      "socket hang up",
    );
  });

  it("throws when the response has no body", async () => {
    const store = createDueStore(
      stubClient(() => ({})),
      "scheduler",
    );
    await expect(store.get("due-times.json")).rejects.toThrow(/no body/);
  });

  it("writes an object as JSON", async () => {
    const client = stubClient(() => ({}));
    const store = createDueStore(client, "scheduler");

    await store.put("due-times.json", '{"a":1}');

    const command = client.send.mock.calls[0]![0] as PutObjectCommand;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toEqual({
      Bucket: "scheduler",
      Key: "due-times.json",
      Body: '{"a":1}',
      ContentType: "application/json",
    });
  });

  it("propagates a failed write", async () => {
    const store = createDueStore(
      stubClient(() => {
        throw awsError("InternalError", 500);
      }),
      "scheduler",
    );
    await expect(store.put("k", "{}")).rejects.toThrow("InternalError");
  });
});

describe("createS3ClientFromEnv", () => {
  const env = {
    AWS_ENDPOINT_URL_S3: "https://storage.example.test",
    AWS_REGION: "us-east-1",
    AWS_ACCESS_KEY_ID: "key",
    AWS_SECRET_ACCESS_KEY: "secret",
  };

  it("builds a path-style client for the injected endpoint", async () => {
    const client = createS3ClientFromEnv(env);
    expect(client.config.forcePathStyle).toBe(true);
    // S3-compatible stores can reject the SDK v3 default checksum headers.
    expect(await client.config.requestChecksumCalculation()).toBe(
      "WHEN_REQUIRED",
    );
    expect(await client.config.responseChecksumValidation()).toBe(
      "WHEN_REQUIRED",
    );
    expect(await client.config.region()).toBe("us-east-1");
    expect((await client.config.endpoint?.())?.hostname).toBe(
      "storage.example.test",
    );
  });

  it.each(Object.keys(env))("names the missing variable %s", (name) => {
    expect(() => createS3ClientFromEnv({ ...env, [name]: undefined })).toThrow(
      name,
    );
  });
});
