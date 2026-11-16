/** Reading a user's two-step secret (split out of `auth.ts` in M7). */
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";
import { authTwoFactors } from "@/db/schema";
import type { Db } from "@/db/types";
import type { Auth } from "./index";

const BASE32_PREFIX = "base32:";

/**
 * A user's confirmed TOTP factor, decrypted with Better Auth's key, or null
 * if they have none. For `verifyStaffSession`, which checks the code itself
 * so it can use the caller's `now` and its own limit. Pass the transaction
 * the check belongs to.
 */
export async function readTwoFactor(
  auth: Auth,
  db: Db,
  userId: string,
): Promise<{
  /** The TOTP secret as bytes, or null if it's in a form we don't read. */
  secret: Uint8Array | null;
  /** Uses up `code` if it's one of the backup codes; true if it was. */
  useBackupCode(code: string): Promise<boolean>;
} | null> {
  const [row] = await db
    .select()
    .from(authTwoFactors)
    .where(
      and(eq(authTwoFactors.userId, userId), eq(authTwoFactors.verified, true)),
    );
  if (!row) return null;
  const { secretConfig } = await auth.$context;
  const plain = await symmetricDecrypt({ key: secretConfig, data: row.secret });
  // The plugin makes plain secrets; an imported base32 one isn't read here.
  const secret = plain.startsWith(BASE32_PREFIX)
    ? null
    : new TextEncoder().encode(plain);
  return {
    secret,
    async useBackupCode(code) {
      let codes: unknown;
      try {
        codes = JSON.parse(
          await symmetricDecrypt({ key: secretConfig, data: row.backupCodes }),
        );
      } catch {
        return false;
      }
      if (!Array.isArray(codes) || !codes.includes(code)) return false;
      const left = await symmetricEncrypt({
        key: secretConfig,
        data: JSON.stringify(codes.filter((c) => c !== code)),
      });
      // Compare-and-set, as the plugin does: of two uses at once, one wins.
      const updated = await db
        .update(authTwoFactors)
        .set({ backupCodes: left })
        .where(
          and(
            eq(authTwoFactors.id, row.id),
            eq(authTwoFactors.backupCodes, row.backupCodes),
          ),
        )
        .returning({ id: authTwoFactors.id });
      return updated.length === 1;
    },
  };
}
