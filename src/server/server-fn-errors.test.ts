import { readdirSync, readFileSync, statSync } from "node:fs";
import type { AsyncLocalStorage } from "node:async_hooks";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { notFound, redirect } from "@tanstack/react-router";
import { createMiddleware, createServerFn } from "@tanstack/react-start";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { IdentityError } from "@/identity/viewer";
import { startInstance } from "@/start";
import {
  SERVER_ERROR,
  scrubServerFnError,
  scrubServerFnErrors,
} from "./server-fn-errors";

const ADDRESS = "leaky@example.test";
const LINK =
  "https://gridlocked.example/settings/delete/confirm?token=secret-token-123";

/** The error a failed outbox insert would raise: the address and the link in its params. */
const leakyQueryError = () =>
  new DrizzleQueryError(
    'insert into "email_outbox" ("to_email", "payload") values ($1, $2)',
    [ADDRESS, JSON.stringify({ url: LINK })],
    Object.assign(new Error(`duplicate key: ${ADDRESS}`), {
      name: "DatabaseError",
    }),
  );

/** Everything written to the console while a test runs, errors with their stacks. */
let logged: string[];
let spies: ReturnType<typeof vi.spyOn>[];
beforeEach(() => {
  logged = [];
  spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logged.push(
        args
          .map((a) =>
            a instanceof Error ? `${a.stack} ${String(a.cause)}` : String(a),
          )
          .join(" "),
      );
    }),
  );
});
afterEach(() => {
  spies.forEach((spy) => spy.mockRestore());
});

/** Neither the value nor anything it carries holds the address or the link. */
function expectValueFree(value: unknown) {
  const error = value as Error;
  const text = [
    error.message,
    error.stack,
    String(error.cause),
    JSON.stringify(error),
    ...logged,
  ].join("\n");
  expect(text).not.toContain(ADDRESS);
  expect(text).not.toContain("example.test");
  expect(text).not.toContain(LINK);
  expect(text).not.toContain("secret-token-123");
  expect(text).not.toContain("gridlocked.example");
}

describe("scrubServerFnError", () => {
  it("turns a database error into a value-free server_error, logging names only", () => {
    const scrubbed = scrubServerFnError(leakyQueryError());
    expect(scrubbed).toBeInstanceOf(Error);
    expect((scrubbed as Error).message).toBe(SERVER_ERROR);
    expect((scrubbed as Error).cause).toBeUndefined();
    expectValueFree(scrubbed);
    expect(logged).toEqual([
      "server function failed: DrizzleQueryError (cause: DatabaseError)",
    ]);
  });

  it("names a class whose name is the generic Error by its constructor, the cause too", () => {
    class PgDriverError extends Error {}
    class WrappedError extends Error {}
    const scrubbed = scrubServerFnError(
      new WrappedError(`wrapped ${LINK}`, {
        cause: new PgDriverError(`duplicate ${ADDRESS}`),
      }),
    );
    expectValueFree(scrubbed);
    expect(logged).toEqual([
      "server function failed: WrappedError (cause: PgDriverError)",
    ]);
    logged.length = 0;
    // A plain Error stays "Error".
    scrubServerFnError(new Error(ADDRESS, { cause: new Error(LINK) }));
    expect(logged).toEqual(["server function failed: Error (cause: Error)"]);
    expectValueFree(new Error(SERVER_ERROR));
  });

  it("scrubs any other error, and a thrown non-error, the same way", () => {
    for (const thrown of [
      new TypeError(`bad ${ADDRESS} at ${LINK}`),
      `${ADDRESS} ${LINK}`,
      { email: ADDRESS, url: LINK },
    ]) {
      const scrubbed = scrubServerFnError(thrown);
      expect((scrubbed as Error).message).toBe(SERVER_ERROR);
      expectValueFree(scrubbed);
    }
    expect(logged).toEqual([
      "server function failed: TypeError",
      "server function failed: string",
      "server function failed: object",
    ]);
  });

  it("lets a refusal, a redirect and a notFound through unchanged", () => {
    const refusal = new IdentityError("read_only");
    const away = redirect({ to: "/sign-in" });
    const missing = notFound();
    expect(scrubServerFnError(refusal)).toBe(refusal);
    expect(scrubServerFnError(away)).toBe(away);
    expect(scrubServerFnError(missing)).toBe(missing);
    expect(logged).toEqual([]);
  });
});

/** Start's own server-side store for the request, as its handler sets it. */
const startStorage = (globalThis as Record<symbol, unknown>)[
  Symbol.for("tanstack-start:start-storage-context")
] as AsyncLocalStorage<unknown>;

type Executed = { result?: unknown; error?: unknown };
/** The builder, loosely typed: the test passes the handler as the compiler does. */
type Builder = {
  middleware: (middleware: unknown[]) => Builder;
  validator: (validator: unknown) => Builder;
  handler: (
    extracted: unknown,
    server: unknown,
  ) => {
    __executeServer: (opts: {
      data: unknown;
      method: string;
    }) => Promise<Executed>;
  };
};

/**
 * Runs a server function as Start's server does for an RPC: its compiled
 * form (the handler as the second argument), through `__executeServer`,
 * with this app's start options.
 */
async function runOnServer(
  handler: () => Promise<unknown>,
  build: (fn: Builder) => Builder = (fn) => fn,
  data?: unknown,
): Promise<Executed> {
  const fn = build(createServerFn({ method: "POST" }) as unknown as Builder);
  const compiled = fn.handler(
    Object.assign(async () => undefined, {
      serverFnMeta: { id: "test-fn" },
    }),
    handler,
  );
  const startOptions = await startInstance.getOptions();
  return startStorage.run(
    {
      startOptions,
      request: new Request("http://localhost:3000/_serverFn/test-fn", {
        method: "POST",
      }),
      contextAfterGlobalMiddlewares: {},
    },
    () => compiled.__executeServer({ data, method: "POST" }),
  );
}

describe("every server function runs inside the scrub", () => {
  it("is registered as global function middleware in start.ts", async () => {
    const options = await startInstance.getOptions();
    expect(options.functionMiddleware).toContain(scrubServerFnErrors);
  });

  it("a handler's database error reaches the browser as server_error, and the log holds no address or link", async () => {
    const { error } = await runOnServer(async () => {
      throw leakyQueryError();
    });
    expect((error as Error).message).toBe(SERVER_ERROR);
    expectValueFree(error);
    expect(logged.join("\n")).toContain("server function failed");
  });

  it("also covers a function's own middleware and its validator", async () => {
    const own = createMiddleware({ type: "function" }).server(async () => {
      throw new Error(`middleware saw ${ADDRESS}`);
    });
    const fromMiddleware = await runOnServer(
      async () => "unreached",
      (fn) => fn.middleware([own]),
    );
    expect((fromMiddleware.error as Error).message).toBe(SERVER_ERROR);
    expectValueFree(fromMiddleware.error);

    const fromValidator = await runOnServer(
      async () => "unreached",
      (fn) =>
        fn.validator(
          z.object({ email: z.string().refine(() => false, ADDRESS) }),
        ),
      { email: ADDRESS },
    );
    expect((fromValidator.error as Error).message).toBe(SERVER_ERROR);
    expectValueFree(fromValidator.error);
  });

  it("a refusal, a redirect and a result come back as they were", async () => {
    const refusal = new IdentityError("unauthenticated");
    expect((await runOnServer(async () => Promise.reject(refusal))).error).toBe(
      refusal,
    );
    const away = redirect({ to: "/sign-in" });
    expect((await runOnServer(async () => Promise.reject(away))).error).toBe(
      away,
    );
    expect(await runOnServer(async () => ({ ok: true }))).toEqual({
      result: { ok: true },
    });
    expect(logged).toEqual([]);
  });

  it("every createServerFn is in src/server, which only the Start app loads", () => {
    // The scrub is global, so a server function anywhere is covered; this
    // keeps the claim in server-fn-errors.ts true as the app grows.
    const src = fileURLToPath(new URL("..", import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          files.push(path);
        }
      }
    };
    walk(src);
    const defining = files
      .filter((path) =>
        /\bcreateServerFn\s*\(/.test(readFileSync(path, "utf8")),
      )
      .map((path) => relative(src, path));
    expect(defining.length).toBeGreaterThan(0);
    for (const path of defining) expect(path).toMatch(/^server\//);
    // And nothing opts out by building its own start instance.
    const starts = files.filter((path) =>
      /\bcreateStart\s*\(/.test(readFileSync(path, "utf8")),
    );
    expect(starts.map((path) => relative(src, path))).toEqual(["start.ts"]);
  });
});
