import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { createS3ClientFromEnv } from "./due-store";
import { createExportStore, EXPORT_BUCKET } from "./export-store";

// Fake values only: presigning is computed locally and sends nothing.
const env = {
  AWS_ENDPOINT_URL_S3: "https://storage.example.invalid",
  AWS_REGION: "aws-us-east-1",
  AWS_ACCESS_KEY_ID: "test-key-id",
  AWS_SECRET_ACCESS_KEY: "test-secret",
};

describe("createExportStore", () => {
  it("writes JSON to the exports bucket and deletes by key", async () => {
    const client = createS3ClientFromEnv(env);
    const send = vi.spyOn(client, "send").mockResolvedValue({} as never);
    const store = createExportStore(client);

    await store.put("exports/r1.json", "{}");
    await store.delete("exports/r1.json");
    const [put, del] = send.mock.calls.map((call) => call[0]);
    expect(put).toBeInstanceOf(PutObjectCommand);
    expect((put as PutObjectCommand).input).toEqual({
      Bucket: "exports",
      Key: "exports/r1.json",
      Body: "{}",
      ContentType: "application/json",
    });
    expect(del).toBeInstanceOf(DeleteObjectCommand);
    expect((del as DeleteObjectCommand).input).toEqual({
      Bucket: "exports",
      Key: "exports/r1.json",
    });
  });

  it("signs a path-style GET for the given seconds, with no request sent", async () => {
    const client = createS3ClientFromEnv(env);
    const send = vi.spyOn(client, "send");
    const store = createExportStore(client);

    const url = new URL(await store.presign("exports/r1.json", 604_800));
    expect(EXPORT_BUCKET).toBe("exports");
    expect(url.origin).toBe("https://storage.example.invalid");
    expect(url.pathname).toBe("/exports/exports/r1.json");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("604800");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(url.searchParams.get("response-content-disposition")).toContain(
      "attachment",
    );
    expect(send).not.toHaveBeenCalled();
  });
});
