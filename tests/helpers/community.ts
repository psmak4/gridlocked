import { asc, eq } from "drizzle-orm";
import {
  categories,
  profiles,
  threads,
  type ThreadKind,
  type UserRole,
} from "@/db/schema";
import type { Db } from "@/db/types";
import type { Viewer } from "@/identity/viewer";
import { newId } from "@/lib/ids";
import { seedUser } from "./users";

/** Seeds a user at a trust level and returns the `Viewer` a request would carry. */
export async function seedViewer(
  db: Db,
  input: { trustLevel?: number; username?: string; role?: UserRole } = {},
): Promise<Viewer> {
  const userId = await seedUser(db, {
    username: input.username,
    role: input.role,
  });
  const [profile] = await db
    .update(profiles)
    .set({ trustLevel: input.trustLevel ?? 0 })
    .where(eq(profiles.userId, userId))
    .returning();
  return {
    userId,
    role: input.role ?? "user",
    banned: false,
    username: input.username?.toLowerCase() ?? null,
    displayUsername: input.username ?? null,
    emailVerified: true,
    twoFactorEnabled: false,
    sessionId: newId(),
    impersonatedBy: null,
    staffVerifiedAt: null,
    profile: profile!,
    complete: true,
  };
}

/** A seeded category's id, by slug (the migration seeds seven). */
export async function categoryId(db: Db, slug = "general"): Promise<string> {
  const [row] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.slug, slug))
    .orderBy(asc(categories.position));
  if (!row) throw new Error(`no category ${slug}`);
  return row.id;
}

/** A bare thread row, for tests that need one to post or chat in. */
export async function seedThread(
  db: Db,
  input: {
    at: Date;
    authorUserId?: string | null;
    category?: string;
    kind?: ThreadKind;
    sessionId?: string | null;
    title?: string;
    status?: "open" | "locked" | "removed" | "archived";
    chatOpensAt?: Date | null;
    chatClosesAt?: Date | null;
    slowModeSeconds?: number | null;
  },
): Promise<string> {
  const id = newId();
  await db.insert(threads).values({
    id,
    categoryId: await categoryId(db, input.category),
    kind: input.kind ?? "user",
    title: input.title ?? "A thread",
    authorUserId: input.authorUserId ?? null,
    sessionId: input.sessionId ?? null,
    status: input.status ?? "open",
    chatOpensAt: input.chatOpensAt ?? null,
    chatClosesAt: input.chatClosesAt ?? null,
    slowModeSeconds: input.slowModeSeconds ?? null,
    lastActivityAt: input.at,
    createdAt: input.at,
  });
  return id;
}
