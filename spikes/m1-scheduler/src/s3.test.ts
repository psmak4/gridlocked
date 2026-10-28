import { describe, expect, it } from "vitest";
import { signRequest } from "./s3";

// AWS's published SigV4 example: "GET Object" from the S3 API reference
// (examplebucket, /test.txt, Range: bytes=0-9, 2013-05-24).
describe("signRequest", () => {
  it("matches AWS's GET Object example signature", async () => {
    const headers = await signRequest({
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers: { range: "bytes=0-9" },
      body: "",
      region: "us-east-1",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      amzDate: "20130524T000000Z",
    });
    expect(headers["x-amz-content-sha256"]).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request," +
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date," +
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });
});
