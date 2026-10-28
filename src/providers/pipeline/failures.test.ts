import { describe, expect, it } from "vitest";
import { ProviderUnavailableError } from "@/jobs/ports";
import { ProviderHttpError } from "../http/client";
import { asOutage } from "./failures";

const fails = (error: unknown) =>
  asOutage("x", async () => {
    throw error;
  });

describe("asOutage", () => {
  it.each([
    ["a 500", new ProviderHttpError(500, "boom")],
    ["a 503", new ProviderHttpError(503, "boom")],
    ["a 429 that outlasted the retries", new ProviderHttpError(429, "slow")],
    ["a non-JSON body (status 200)", new ProviderHttpError(200, "not JSON")],
  ])("%s is an outage", async (_name, error) => {
    await expect(fails(error)).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it.each([400, 401, 403, 404, 410, 304])(
    "a %i is a bug in the request: it passes through unchanged",
    async (status) => {
      const error = new ProviderHttpError(status, "no");
      await expect(fails(error)).rejects.toBe(error);
    },
  );

  it("a TypeError that did not come from the fetch call (a bad URL) passes through", async () => {
    const error = new TypeError("Invalid URL");
    await expect(fails(error)).rejects.toBe(error);
  });

  it("any other error passes through", async () => {
    const error = new Error("database is down");
    await expect(fails(error)).rejects.toBe(error);
  });
});
