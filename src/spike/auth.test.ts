import { readFile } from "node:fs/promises";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";
import { createAuth } from "./auth";

type TestDb = Awaited<ReturnType<typeof createTestDb>>;
let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
  const ddl = await readFile(
    path.join(process.cwd(), "src/spike/auth.sql"),
    "utf8",
  );
  for (const statement of ddl.split("--> statement-breakpoint")) {
    if (statement.trim()) await t.db.execute(sql.raw(statement));
  }
});
afterAll(() => t.close());

describe("createAuth", () => {
  it("marks the session cookie Secure, HttpOnly and SameSite=Lax on a host", async () => {
    const origin = "https://gridlocked-spike.vercel.app";
    const res = await createAuth(t.db).handler(
      new Request(`${origin}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          email: "cookie@example.test",
          password: "spike-password-1",
          name: "cookie",
        }),
      }),
    );
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/session_token=/);
    expect(cookie).toMatch(/;\s*Secure/i);
    expect(cookie).toMatch(/;\s*HttpOnly/i);
    expect(cookie).toMatch(/;\s*SameSite=Lax/i);
  });
});
