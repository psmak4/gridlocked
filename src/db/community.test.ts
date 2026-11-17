import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asc, sql } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import { seedUser } from "../../tests/helpers/users";
import { scrubAccount } from "@/identity/delete";
import { buildExport } from "@/identity/export";
import { newId } from "@/lib/ids";
import {
  categories,
  chatMessages,
  postMentions,
  postRevisions,
  posts,
  postVotes,
  threads,
  userRestrictions,
} from "./schema";

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

const AT = new Date("2026-02-01T00:00:00Z");
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";

/** The SQLSTATE is on the error or its cause. */
async function expectPgError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, "expected the statement to be rejected").toBeDefined();
  const direct = (error as { code?: string }).code;
  const cause = (error as { cause?: { code?: string } }).cause?.code;
  expect(direct ?? cause).toBe(code);
}

/** An ltree label from a uuid: labels allow letters, digits and `_`. */
const label = (id: string) => id.replaceAll("-", "_");

describe("community tables (DM 5.2–5.6)", () => {
  let t: TestDb;
  let author: string;
  let categoryId: string;

  beforeEach(async () => {
    t = await createTestDb();
    author = await seedUser(t.db, { username: "late_braker" });
    const [general] = await t.db
      .select()
      .from(categories)
      .orderBy(asc(categories.position))
      .limit(1);
    categoryId = general!.id;
  });

  afterEach(async () => {
    await t.close();
  });

  async function newThread(kind = "user") {
    const id = newId();
    await t.db.insert(threads).values({
      id,
      categoryId,
      kind: kind as "user",
      title: "Who's watching qualifying?",
      authorUserId: author,
      lastActivityAt: AT,
      createdAt: AT,
    });
    return id;
  }

  async function newPost(threadId: string, parentPath: string | null) {
    const id = newId();
    const path = parentPath ? `${parentPath}.${label(id)}` : label(id);
    await t.db.insert(posts).values({
      id,
      threadId,
      path,
      depth: path.split(".").length - 1,
      isOpening: false,
      authorUserId: author,
      body: "text",
      createdAt: AT,
    });
    return { id, path };
  }

  it("the migration seeds seven categories in order", async () => {
    const rows = await t.db
      .select({
        slug: categories.slug,
        name: categories.name,
        kind: categories.kind,
        position: categories.position,
        minTrust: categories.minTrustToStartThread,
        status: categories.status,
      })
      .from(categories)
      .orderBy(asc(categories.position));
    expect(rows.map((r) => [r.slug, r.name, r.kind])).toEqual([
      ["race-weekend", "Race Weekend", "race_weekend"],
      ["fantasy", "Fantasy", "fantasy"],
      ["teams-and-drivers", "Teams & Drivers", "general"],
      ["technical", "Technical", "general"],
      ["silly-season", "Silly Season", "general"],
      ["general", "General", "general"],
      ["off-topic", "Off-topic", "general"],
    ]);
    expect(rows.map((r) => r.position)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(rows.every((r) => r.minTrust === 1 && r.status === "active")).toBe(
      true,
    );
  });

  it("a post's path loads its whole subtree in path order", async () => {
    const threadId = await newThread();
    const one = await newPost(threadId, null);
    const two = await newPost(threadId, one.path);
    const three = await newPost(threadId, two.path);
    const four = await newPost(threadId, one.path);
    // Another root, outside the subtree.
    await newPost(threadId, null);

    const rows = await t.db
      .select({ id: posts.id })
      .from(posts)
      .where(sql`${posts.path} <@ ${one.path}::ltree`)
      .orderBy(asc(posts.path));
    expect(rows.map((r) => r.id)).toEqual([one.id, two.id, three.id, four.id]);
  });

  it("a second vote by the same user on the same post is refused", async () => {
    const threadId = await newThread();
    const { id: postId } = await newPost(threadId, null);
    const voter = await seedUser(t.db);
    await t.db
      .insert(postVotes)
      .values({ postId, userId: voter, value: 1, createdAt: AT });
    await expectPgError(
      t.db
        .insert(postVotes)
        .values({ postId, userId: voter, value: -1, createdAt: AT }),
      UNIQUE_VIOLATION,
    );
    // And a vote is only ever 1 or -1.
    await expectPgError(
      t.db
        .insert(postVotes)
        .values({ postId, userId: author, value: 2, createdAt: AT }),
      CHECK_VIOLATION,
    );
  });

  it("a thread kind outside the list is refused", async () => {
    await expectPgError(newThread("poll"), CHECK_VIOLATION);
  });

  it("an export lists the forum rows, and a deletion keeps them on the tombstone", async () => {
    const threadId = await newThread();
    const { id: postId, path } = await newPost(threadId, null);
    await newPost(threadId, path);
    await t.db.insert(postRevisions).values({
      id: newId(),
      postId,
      body: "first text",
      editedAt: AT,
      editedBy: author,
    });
    await t.db
      .insert(postVotes)
      .values({ postId, userId: author, value: 1, createdAt: AT });
    const other = await seedUser(t.db);
    await t.db.insert(postMentions).values({ postId, userId: author });
    await t.db.insert(postMentions).values({ postId, userId: other });

    await t.db.insert(chatMessages).values({
      id: newId(),
      threadId,
      authorUserId: author,
      body: "lights out",
      createdAt: AT,
    });
    await t.db.insert(userRestrictions).values({
      id: newId(),
      userId: author,
      kind: "mute",
      until: null,
      reason: "Cooling off",
      createdBy: other,
      createdAt: AT,
    });

    const data = (await buildExport(t.db, author)) as Record<string, unknown[]>;
    expect(data.threads).toMatchObject([
      { id: threadId, category: "race-weekend" },
    ]);
    expect(data.posts).toHaveLength(2);
    expect(data.postRevisions).toMatchObject([{ postId, body: "first text" }]);
    expect(data.votes).toMatchObject([{ postId, value: 1 }]);
    expect(data.chat).toMatchObject([{ body: "lights out" }]);
    expect(data.restrictions).toMatchObject([
      { kind: "mute", reason: "Cooling off" },
    ]);

    await scrubAccount(t.db, AT, {
      userId: author,
      actor: { kind: "user", userId: author, label: null },
    });
    expect(await t.db.select().from(posts)).toHaveLength(2);
    expect(await t.db.select().from(postVotes)).toHaveLength(1);
    expect(await t.db.select().from(chatMessages)).toHaveLength(1);
    // Only the deleted account's mention goes.
    expect(await t.db.select().from(postMentions)).toMatchObject([
      { userId: other },
    ]);
  });
});
