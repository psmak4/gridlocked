import type { Db } from "@/db/types";
import { profiles, users, type UserRole } from "@/db/schema";
import { newId } from "@/lib/ids";

/** Every seeded row carries this, so a test never reads the clock. */
const SEEDED_AT = new Date("2026-01-01T00:00:00Z");

export type SeedUserInput = {
  id?: string;
  email?: string;
  username?: string;
  role?: UserRole;
  emailVerified?: boolean;
};

/**
 * Writes a `users` row and its `profiles` row, and returns the user's id.
 * The email and username default to values unique to the id.
 */
export async function seedUser(
  db: Db,
  input: SeedUserInput = {},
): Promise<string> {
  const id = input.id ?? newId();
  const username =
    input.username ?? `user_${id.replaceAll("-", "").slice(-12)}`;
  await db.insert(users).values({
    id,
    name: username,
    email: input.email ?? `${username.toLowerCase()}@example.test`,
    emailVerified: input.emailVerified ?? true,
    role: input.role ?? "user",
    username: username.toLowerCase(),
    displayUsername: username,
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT,
  });
  await db.insert(profiles).values({
    userId: id,
    status: "active",
    avatarSeed: id,
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT,
  });
  return id;
}
