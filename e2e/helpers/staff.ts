import { createHmac } from "node:crypto";
import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { ORIGIN } from "./accounts";

/** Local-only hook: makes the account with this address an admin. */
export async function makeAdmin(request: APIRequestContext, email: string) {
  const response = await request.post("/api/test/make-admin", {
    headers: { origin: ORIGIN },
    data: { email },
  });
  expect(response.status()).toBe(200);
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error("not base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 6238 at the current time, as an authenticator app would show it. */
export function totpCode(
  setupKey: string,
  // An authenticator reads the wall clock, and so does the server's check.
  // eslint-disable-next-line no-restricted-syntax
  at: number = Date.now(),
): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac("sha1", base32Decode(setupKey))
    .update(counter)
    .digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 1_000_000).padStart(6, "0");
}

/**
 * Turns on two-step sign-in from the security page, as a new admin would:
 * password, the setup key, a code from the "app". Returns the setup key and
 * the backup codes shown once.
 */
export async function setUpTotp(
  page: Page,
  password: string,
): Promise<{ setupKey: string; backupCodes: string[] }> {
  await page.goto("/settings/security");
  const section = page.getByRole("region", { name: "Two-step sign-in" });
  await section.getByLabel("Your password").fill(password);
  await section
    .getByRole("button", { name: "Set up an authenticator app" })
    .click();
  const keyText = await section.getByTestId("setup-key").innerText();
  const setupKey = keyText.replace(/\s/g, "");
  await section.getByLabel("Code from the app").fill(totpCode(setupKey));
  await section.getByRole("button", { name: "Turn on" }).click();
  await expect(section.getByText("Two-step sign-in is on.")).toBeVisible();
  const backupCodes = (
    await section
      .getByTestId("backup-codes")
      .getByRole("listitem")
      .allInnerTexts()
  ).map((code) => code.trim());
  return { setupKey, backupCodes };
}
