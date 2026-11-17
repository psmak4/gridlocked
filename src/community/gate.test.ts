import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";
import {
  categoryId,
  seedThread,
  seedViewer,
} from "../../tests/helpers/community";
import {
  chatMessages,
  constructors,
  drivers,
  filterRules,
  posts,
  userRestrictions,
} from "@/db/schema";
import { SYSTEM_USER_ID } from "@/identity/system";
import type { Viewer } from "@/identity/viewer";
import { newId } from "@/lib/ids";
import { checkPost, looksLikeSpoilerTitle, matchFilters } from "./gate";

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

const NOW = new Date("2026-03-07T12:00:00Z");
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);
const later = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);

describe("the posting gate (checkPost)", () => {
  let t: TestDb;
  let threadId: string;

  beforeEach(async () => {
    t = await createTestDb();
    threadId = await seedThread(t.db, { at: ago(3600) });
  });

  afterEach(async () => {
    await t.close();
  });

  /** A reply row by the viewer, `secondsAgo` before NOW. */
  async function pastReply(viewer: Viewer, secondsAgo: number, body = "hi") {
    const id = newId();
    await t.db.insert(posts).values({
      id,
      threadId,
      path: id.replaceAll("-", "_"),
      authorUserId: viewer.userId,
      body,
      createdAt: ago(secondsAgo),
    });
  }

  const reply = (viewer: Viewer, body: string) =>
    checkPost(t.db, NOW, viewer, { kind: "reply", threadId, body });

  it("a TL0 viewer starting a thread gets trust_too_low", async () => {
    const tl0 = await seedViewer(t.db, { trustLevel: 0 });
    expect(
      await checkPost(t.db, NOW, tl0, {
        kind: "thread",
        categoryId: await categoryId(t.db, "general"),
        title: "Who's watching qualifying?",
        body: "Anyone?",
      }),
    ).toEqual({ ok: false, error: "trust_too_low" });

    const tl1 = await seedViewer(t.db, { trustLevel: 1 });
    expect(
      await checkPost(t.db, NOW, tl1, {
        kind: "thread",
        categoryId: await categoryId(t.db, "general"),
        title: "Who's watching qualifying?",
        body: "Anyone?",
      }),
    ).toMatchObject({ ok: true, hold: false, spoilerTitle: false });
  });

  it("a TL0 viewer's 4th reply in 10 minutes gets rate_limited with retryAfterSeconds", async () => {
    const tl0 = await seedViewer(t.db, { trustLevel: 0 });
    await pastReply(tl0, 540, "one");
    await pastReply(tl0, 300, "two");
    await pastReply(tl0, 60, "three");
    // The oldest leaves the 10-minute window 60 seconds from now.
    expect(await reply(tl0, "four")).toEqual({
      ok: false,
      error: "rate_limited",
      retryAfterSeconds: 60,
    });
    // A reply 11 minutes old doesn't count.
    const other = await seedViewer(t.db, { trustLevel: 0 });
    await pastReply(other, 660, "old");
    await pastReply(other, 300, "two");
    await pastReply(other, 60, "three");
    expect(await reply(other, "four")).toMatchObject({ ok: true });
  });

  it("a TL0 link gets links_not_allowed, and a TL1 post's second link gets too_many_links", async () => {
    const tl0 = await seedViewer(t.db, { trustLevel: 0 });
    expect(await reply(tl0, "See https://example.com/a")).toEqual({
      ok: false,
      error: "links_not_allowed",
    });
    const tl1 = await seedViewer(t.db, { trustLevel: 1 });
    expect(await reply(tl1, "See https://example.com/a")).toMatchObject({
      ok: true,
    });
    expect(
      await reply(tl1, "See https://example.com/a and www.example.org/b"),
    ).toEqual({ ok: false, error: "too_many_links" });
    const tl2 = await seedViewer(t.db, { trustLevel: 2 });
    expect(
      await reply(tl2, "https://a.example https://b.example https://c.example"),
    ).toMatchObject({ ok: true });
  });

  it("six mentions get too_many_mentions", async () => {
    const tl1 = await seedViewer(t.db, { trustLevel: 1 });
    expect(
      await reply(tl1, "@ann @bob @cat @dan @eve thoughts?"),
    ).toMatchObject({ ok: true });
    expect(await reply(tl1, "@ann @bob @cat @dan @eve @fay thoughts?")).toEqual(
      { ok: false, error: "too_many_mentions" },
    );
    // The same name twice is one mention; an email address is none.
    expect(
      await reply(tl1, "@ann @ann @bob @cat @dan @eve me@example.test"),
    ).toMatchObject({ ok: true });
  });

  it("the same body twice in 24 hours gets duplicate", async () => {
    const tl1 = await seedViewer(t.db, { trustLevel: 1 });
    await pastReply(tl1, 23 * 3600, "Box box");
    expect(await reply(tl1, "  Box box ")).toEqual({
      ok: false,
      error: "duplicate",
    });
    const other = await seedViewer(t.db, { trustLevel: 1 });
    await pastReply(other, 25 * 3600, "Box box");
    expect(await reply(other, "Box box")).toMatchObject({ ok: true });
  });

  it("an active mute restriction gets muted, and one whose until has passed allows the post", async () => {
    const tl1 = await seedViewer(t.db, { trustLevel: 1 });
    const restrict = (
      kind: "mute" | "chat_ban" | "thread_ban",
      until: Date | null,
    ) =>
      t.db.insert(userRestrictions).values({
        id: newId(),
        userId: tl1.userId,
        kind,
        until,
        reason: "Cooling off",
        createdBy: SYSTEM_USER_ID,
        createdAt: ago(60),
      });
    await restrict("mute", later(60));
    expect(await reply(tl1, "hello")).toEqual({ ok: false, error: "muted" });

    const other = await seedViewer(t.db, { trustLevel: 1 });
    await t.db.insert(userRestrictions).values({
      id: newId(),
      userId: other.userId,
      kind: "mute",
      until: ago(1),
      reason: "Over",
      createdBy: SYSTEM_USER_ID,
      createdAt: ago(3600),
    });
    expect(await reply(other, "hello")).toMatchObject({ ok: true });

    // A lifted restriction no longer counts either.
    const third = await seedViewer(t.db, { trustLevel: 1 });
    await t.db.insert(userRestrictions).values({
      id: newId(),
      userId: third.userId,
      kind: "mute",
      until: null,
      reason: "Lifted",
      createdBy: SYSTEM_USER_ID,
      createdAt: ago(3600),
      liftedAt: ago(10),
    });
    expect(await reply(third, "hello")).toMatchObject({ ok: true });
  });

  it("a chat ban refuses chat only, and a thread ban refuses new threads only", async () => {
    const chatThread = await seedThread(t.db, {
      at: ago(3600),
      chatOpensAt: ago(600),
      chatClosesAt: later(3600),
    });
    const tl1 = await seedViewer(t.db, { trustLevel: 1 });
    await t.db.insert(userRestrictions).values([
      {
        id: newId(),
        userId: tl1.userId,
        kind: "chat_ban",
        until: null,
        reason: "Spam",
        createdBy: SYSTEM_USER_ID,
        createdAt: ago(60),
      },
      {
        id: newId(),
        userId: tl1.userId,
        kind: "thread_ban",
        until: null,
        reason: "Spam",
        createdBy: SYSTEM_USER_ID,
        createdAt: ago(60),
      },
    ]);
    expect(
      await checkPost(t.db, NOW, tl1, {
        kind: "chat",
        threadId: chatThread,
        body: "go go",
      }),
    ).toEqual({ ok: false, error: "chat_banned" });
    expect(
      await checkPost(t.db, NOW, tl1, {
        kind: "thread",
        categoryId: await categoryId(t.db, "general"),
        title: "A title",
        body: "text",
      }),
    ).toEqual({ ok: false, error: "thread_banned" });
    expect(await reply(tl1, "a reply")).toMatchObject({ ok: true });
  });

  it("a block filter refuses, a hold_for_review filter returns hold, and a flag filter returns its hit", async () => {
    const rule = (
      pattern: string,
      effect: "block" | "hold_for_review" | "flag",
      matchType: "word" | "regex" | "domain" = "word",
    ) =>
      t.db.insert(filterRules).values({
        id: newId(),
        pattern,
        matchType,
        effect,
        scope: "all",
        createdBy: SYSTEM_USER_ID,
      });
    await rule("scam", "block");
    await rule("crypto", "hold_for_review");
    await rule("idiot", "flag");
    const tl2 = await seedViewer(t.db, { trustLevel: 2 });

    expect(await reply(tl2, "Not a SCAM, honest")).toEqual({
      ok: false,
      error: "blocked",
    });
    expect(await reply(tl2, "Buy crypto now")).toMatchObject({
      ok: true,
      hold: true,
    });
    const flagged = await reply(tl2, "What an idiot move");
    expect(flagged).toMatchObject({ ok: true, hold: false });
    expect(flagged.ok && flagged.flags).toMatchObject([
      { effect: "flag", pattern: "idiot", field: "body" },
    ]);
    // A word rule matches whole words only.
    expect(await reply(tl2, "Scampi for lunch")).toMatchObject({
      ok: true,
      hold: false,
      flags: [],
    });
  });

  it("a TL0 chat message 4 seconds after the last gets slow_mode, with retryAfterSeconds: 6", async () => {
    const chatThread = await seedThread(t.db, {
      at: ago(3600),
      chatOpensAt: ago(600),
      chatClosesAt: later(3600),
    });
    const tl0 = await seedViewer(t.db, { trustLevel: 0 });
    const chat = (viewer: Viewer, body: string) =>
      checkPost(t.db, NOW, viewer, {
        kind: "chat",
        threadId: chatThread,
        body,
      });
    await t.db.insert(chatMessages).values({
      id: newId(),
      threadId: chatThread,
      authorUserId: tl0.userId,
      body: "lights out",
      createdAt: ago(4),
    });
    expect(await chat(tl0, "and away")).toEqual({
      ok: false,
      error: "slow_mode",
      retryAfterSeconds: 6,
    });
    // TL2 has no slow mode, unless a moderator sets one on the thread.
    const tl2 = await seedViewer(t.db, { trustLevel: 2 });
    await t.db.insert(chatMessages).values({
      id: newId(),
      threadId: chatThread,
      authorUserId: tl2.userId,
      body: "lights out",
      createdAt: ago(1),
    });
    expect(await chat(tl2, "and away")).toMatchObject({ ok: true });

    const slowThread = await seedThread(t.db, {
      at: ago(3600),
      chatOpensAt: ago(600),
      chatClosesAt: later(3600),
      slowModeSeconds: 30,
    });
    await t.db.insert(chatMessages).values({
      id: newId(),
      threadId: slowThread,
      authorUserId: tl2.userId,
      body: "lights out",
      createdAt: ago(10),
    });
    expect(
      await checkPost(t.db, NOW, tl2, {
        kind: "chat",
        threadId: slowThread,
        body: "and away",
      }),
    ).toEqual({ ok: false, error: "slow_mode", retryAfterSeconds: 20 });
  });

  it("a chat message over 500 characters and a post over 10,000 get too_long", async () => {
    const chatThread = await seedThread(t.db, {
      at: ago(3600),
      chatOpensAt: ago(600),
      chatClosesAt: later(3600),
    });
    const tl1 = await seedViewer(t.db, { trustLevel: 1 });
    expect(
      await checkPost(t.db, NOW, tl1, {
        kind: "chat",
        threadId: chatThread,
        body: "a".repeat(501),
      }),
    ).toEqual({ ok: false, error: "too_long" });
    expect(await reply(tl1, "a".repeat(10_001))).toEqual({
      ok: false,
      error: "too_long",
    });
  });

  it("an edit isn't rate limited or a duplicate, but still meets the other rules", async () => {
    const tl0 = await seedViewer(t.db, { trustLevel: 0 });
    await pastReply(tl0, 540, "one");
    await pastReply(tl0, 300, "two");
    await pastReply(tl0, 60, "three");
    const edit = (body: string) =>
      checkPost(t.db, NOW, tl0, { kind: "edit", threadId, body });
    expect(await edit("three")).toMatchObject({ ok: true });
    expect(await edit("See https://example.com")).toEqual({
      ok: false,
      error: "links_not_allowed",
    });
  });

  it("a reply to a locked thread gets thread_locked, and to a missing one not_found", async () => {
    const locked = await seedThread(t.db, { at: ago(3600), status: "locked" });
    const tl1 = await seedViewer(t.db, { trustLevel: 1 });
    expect(
      await checkPost(t.db, NOW, tl1, {
        kind: "reply",
        threadId: locked,
        body: "hello",
      }),
    ).toEqual({ ok: false, error: "thread_locked" });
    expect(
      await checkPost(t.db, NOW, tl1, {
        kind: "reply",
        threadId: newId(),
        body: "hello",
      }),
    ).toEqual({ ok: false, error: "not_found" });
  });

  it("a race weekend thread title that names a driver with a result is flagged as a spoiler", async () => {
    const tl1 = await seedViewer(t.db, { trustLevel: 1 });
    const start = async (category: string, title: string) =>
      checkPost(t.db, NOW, tl1, {
        kind: "thread",
        categoryId: await categoryId(t.db, category),
        title,
        body: "text",
      });
    await t.db.insert(drivers).values({
      id: newId(),
      slug: "max_verstappen",
      givenName: "Max",
      familyName: "Verstappen",
      nationality: "Dutch",
    });
    await t.db.insert(constructors).values({
      id: newId(),
      slug: "ferrari",
      name: "Ferrari",
      nationality: "Italian",
    });
    expect(await start("race-weekend", "Verstappen wins!")).toMatchObject({
      ok: true,
      spoilerTitle: true,
    });
    expect(await start("race-weekend", "Ferrari on pole")).toMatchObject({
      ok: true,
      spoilerTitle: true,
    });
    // The check is for Race Weekend only (DM 5.2).
    expect(await start("general", "Verstappen wins!")).toMatchObject({
      ok: true,
      spoilerTitle: false,
    });
  });
});

describe("looksLikeSpoilerTitle", () => {
  const names = {
    driverNames: ["Verstappen", "Hamilton"],
    teamNames: ["Ferrari", "Red Bull"],
  };

  it("is true for a driver or team name with a result word", () => {
    expect(looksLikeSpoilerTitle("Verstappen wins!", names)).toBe(true);
    expect(
      looksLikeSpoilerTitle("Ferrari 1-2? No, P3 for Hamilton", names),
    ).toBe(true);
    expect(looksLikeSpoilerTitle("Red Bull DNF again", names)).toBe(true);
    expect(looksLikeSpoilerTitle("hamilton on POLE", names)).toBe(true);
  });

  it("is false without both", () => {
    expect(looksLikeSpoilerTitle("Who's watching qualifying?", names)).toBe(
      false,
    );
    expect(looksLikeSpoilerTitle("Verstappen's new helmet", names)).toBe(false);
    expect(looksLikeSpoilerTitle("Who wins today?", names)).toBe(false);
    // P21 isn't a finishing place, and "crashing" isn't "crash".
    expect(looksLikeSpoilerTitle("Hamilton P21 cosplay", names)).toBe(false);
  });
});

describe("matchFilters", () => {
  const rule = (
    pattern: string,
    matchType: "word" | "regex" | "domain",
    scope: "all" | "titles" | "chat" = "all",
  ) => ({
    id: newId(),
    pattern,
    matchType,
    effect: "flag" as const,
    scope,
  });

  it("matches words, regexes and link domains in scope", () => {
    expect(
      matchFilters([rule("spam", "word")], "body", "so much SPAM here"),
    ).toHaveLength(1);
    expect(
      matchFilters([rule("^buy\\b", "regex")], "body", "Buy now"),
    ).toHaveLength(1);
    expect(
      matchFilters(
        [rule("bad.example", "domain")],
        "body",
        "see https://www.bad.example/x and https://notbad.example",
      ),
    ).toHaveLength(1);
    expect(
      matchFilters(
        [rule("bad.example", "domain")],
        "body",
        "bad.example rules",
      ),
    ).toHaveLength(0);
    // Scopes: a titles rule never reads a body, a chat rule only reads chat.
    expect(
      matchFilters([rule("spam", "word", "titles")], "body", "spam"),
    ).toEqual([]);
    expect(
      matchFilters([rule("spam", "word", "titles")], "title", "spam"),
    ).toHaveLength(1);
    expect(
      matchFilters([rule("spam", "word", "chat")], "body", "spam"),
    ).toEqual([]);
    expect(
      matchFilters([rule("spam", "word", "chat")], "chat", "spam"),
    ).toHaveLength(1);
    // A broken regex matches nothing rather than throwing.
    expect(matchFilters([rule("(", "regex")], "body", "(")).toEqual([]);
  });
});
