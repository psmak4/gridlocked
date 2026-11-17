/**
 * The posting gate (HLD §7.4, DM 5.9): every thread, reply and chat message
 * passes `checkPost` before its insert. Cheapest first: restrictions and the
 * target, trust, length, rate limits and slow mode, links and mentions,
 * duplicates, then the hard-rule filters. Rate limits count the person's own
 * recent rows, so there is no counter table to drift.
 */
import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import {
  categories,
  chatMessages,
  constructorSeasons,
  constructors,
  drivers,
  filterRules,
  posts,
  profiles,
  threads,
  userRestrictions,
  POST_BODY_MAX,
  THREAD_TITLE_MAX,
  FILTER_EFFECTS,
  FILTER_MATCH_TYPES,
  FILTER_SCOPES,
  type RestrictionKind,
} from "@/db/schema";
import type { Db } from "@/db/types";
import type { Viewer } from "@/identity/viewer";
import { getSetting } from "@/settings";
import { refuse, type CommunityRefusal } from "./errors";

export type PostKind = "thread" | "reply" | "chat";

type FilterEffect = (typeof FILTER_EFFECTS)[number];
type FilterMatchType = (typeof FILTER_MATCH_TYPES)[number];
type FilterScope = (typeof FILTER_SCOPES)[number];

export type CheckPostInput = {
  kind: PostKind;
  /** For a reply or a chat message. */
  threadId?: string;
  /** For a new thread. */
  categoryId?: string;
  /** For a new thread. */
  title?: string;
  body: string;
};

/** Where a filter rule matched: a thread's title, a post's body or chat. */
export type FilterField = "title" | "body" | "chat";

export type FilterRule = {
  id: string;
  pattern: string;
  matchType: FilterMatchType;
  effect: FilterEffect;
  scope: FilterScope;
};

export type FilterHit = {
  ruleId: string;
  pattern: string;
  matchType: FilterMatchType;
  effect: FilterEffect;
  field: FilterField;
};

export type CheckPostResult =
  | {
      ok: true;
      /** A `hold_for_review` rule matched: create it `pending_review`. */
      hold: boolean;
      /** Every rule that matched and didn't block, for the queue item. */
      flags: FilterHit[];
      /** A Race Weekend title that looks like a result (DM 5.2, HLD §7.3). */
      spoilerTitle: boolean;
    }
  | CommunityRefusal;

type Tier = "tl0" | "tl1" | "tl2" | "tl3";

const STAFF = new Set(["moderator", "admin"]);

/** Staff count as TL3 for limits and trust. */
function effectiveLevel(viewer: Viewer, trustLevel: number): number {
  return STAFF.has(viewer.role) ? 3 : trustLevel;
}

const tierOf = (level: number): Tier =>
  (["tl0", "tl1", "tl2", "tl3"] as const)[Math.max(0, Math.min(3, level))]!;

const secondsUntil = (from: Date, to: Date) =>
  Math.max(1, Math.ceil((to.getTime() - from.getTime()) / 1000));

// --- Text checks (pure) ------------------------------------------------------

/** A link: `http(s)://…` or `www.…`, stopping at brackets so Markdown counts once. */
const LINK = /\bhttps?:\/\/[^\s<>()[\]]+|\bwww\.[^\s<>()[\]]+/gi;

export function linksIn(text: string): string[] {
  return text.match(LINK) ?? [];
}

function hostOf(link: string): string | null {
  try {
    const url = new URL(/^https?:\/\//i.test(link) ? link : `http://${link}`);
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * The usernames a text mentions, lower case and once each. `@` must start a
 * word, so an email address mentions nobody.
 */
export function mentionedNames(text: string): string[] {
  const names = new Set<string>();
  for (const m of text.matchAll(/(?<![\w@.])@([A-Za-z0-9_.]+)/g)) {
    const name = m[1]!.replace(/\.+$/, "").toLowerCase();
    if (name) names.add(name);
  }
  return [...names];
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `word` as a whole word, ignoring case. */
const wordPattern = (word: string) =>
  new RegExp(
    `(^|[^\\p{L}\\p{N}_])${escapeRegExp(word)}($|[^\\p{L}\\p{N}_])`,
    "iu",
  );

function appliesTo(scope: FilterScope, field: FilterField): boolean {
  if (scope === "all") return true;
  if (scope === "titles") return field === "title";
  if (scope === "chat") return field === "chat";
  return false;
}

/** The rules in scope for `field` that match `text`. Pure. */
export function matchFilters(
  rules: readonly FilterRule[],
  field: FilterField,
  text: string,
): FilterHit[] {
  const hits: FilterHit[] = [];
  for (const rule of rules) {
    if (!appliesTo(rule.scope, field)) continue;
    let matched = false;
    if (rule.matchType === "word") {
      matched = wordPattern(rule.pattern).test(text);
    } else if (rule.matchType === "regex") {
      try {
        matched = new RegExp(rule.pattern, "i").test(text);
      } catch {
        // A bad pattern blocks nothing; it must not break posting either.
        matched = false;
      }
    } else {
      const domain = rule.pattern.toLowerCase();
      matched = linksIn(text).some((link) => {
        const host = hostOf(link);
        return (
          host !== null && (host === domain || host.endsWith(`.${domain}`))
        );
      });
    }
    if (matched) {
      hits.push({
        ruleId: rule.id,
        pattern: rule.pattern,
        matchType: rule.matchType,
        effect: rule.effect,
        field,
      });
    }
  }
  return hits;
}

/** A finishing place P1–P20, or a word that gives a result away. */
const RESULT_WORD =
  /(^|[^\p{L}\p{N}])(win|wins|won|pole|podium|dnf|crash|crashed|retires|retired|p(?:1[0-9]|20|[1-9]))(?=$|[^\p{L}\p{N}])/iu;

/**
 * True when a title names a driver or team and a result word (HLD §7.3's
 * spoiler-safe check). A soft check: the thread is flagged, not refused.
 */
export function looksLikeSpoilerTitle(
  title: string,
  context: { driverNames: string[]; teamNames: string[] },
): boolean {
  if (!RESULT_WORD.test(title)) return false;
  return [...context.driverNames, ...context.teamNames].some(
    (name) => name.trim() !== "" && wordPattern(name.trim()).test(title),
  );
}

// --- The gate ----------------------------------------------------------------

/** The trust level and active restriction kinds, in one query (DM 5.9). */
async function standing(db: Db, now: Date, userId: string) {
  const [row] = await db
    .select({
      trustLevel: profiles.trustLevel,
      restrictions: sql<
        RestrictionKind[]
      >`coalesce(array_agg(distinct ${userRestrictions.kind}) filter (where ${userRestrictions.id} is not null), '{}')`,
    })
    .from(profiles)
    .leftJoin(
      userRestrictions,
      and(
        eq(userRestrictions.userId, profiles.userId),
        isNull(userRestrictions.liftedAt),
        or(isNull(userRestrictions.until), gt(userRestrictions.until, now)),
      ),
    )
    .where(eq(profiles.userId, userId))
    .groupBy(profiles.userId, profiles.trustLevel);
  return row ?? null;
}

async function spoilerNames(db: Db) {
  const [driverRows, teamRows, seasonRows] = await Promise.all([
    db.select({ name: drivers.familyName }).from(drivers),
    db.select({ name: constructors.name }).from(constructors),
    db
      .selectDistinct({ name: constructorSeasons.shortName })
      .from(constructorSeasons),
  ]);
  return {
    driverNames: driverRows.map((r) => r.name),
    teamNames: [...teamRows, ...seasonRows].map((r) => r.name),
  };
}

/**
 * Whether `viewer` may write this thread, reply or chat message now. The
 * caller has already run `canPost`. The insert re-checks what the database
 * can (DM 5.5).
 */
export async function checkPost(
  db: Db,
  now: Date,
  viewer: Viewer,
  input: CheckPostInput,
): Promise<CheckPostResult> {
  const me = await standing(db, now, viewer.userId);
  if (!me) return refuse("forbidden");
  const restricted = new Set(me.restrictions);
  if (restricted.has("mute")) return refuse("muted");
  if (input.kind === "chat" && restricted.has("chat_ban")) {
    return refuse("chat_banned");
  }
  if (input.kind === "thread" && restricted.has("thread_ban")) {
    return refuse("thread_banned");
  }

  const level = effectiveLevel(viewer, me.trustLevel);
  const tier = tierOf(level);

  // The target.
  let categoryKind: string | null = null;
  let threadSlowMode = 0;
  if (input.kind === "thread") {
    if (!input.categoryId) return refuse("not_found");
    const [category] = await db
      .select({
        kind: categories.kind,
        minTrust: categories.minTrustToStartThread,
        status: categories.status,
      })
      .from(categories)
      .where(eq(categories.id, input.categoryId));
    if (!category || category.status !== "active") return refuse("not_found");
    if (level < category.minTrust) return refuse("trust_too_low");
    categoryKind = category.kind;
  } else {
    if (!input.threadId) return refuse("not_found");
    const [thread] = await db
      .select({ status: threads.status, slowMode: threads.slowModeSeconds })
      .from(threads)
      .where(eq(threads.id, input.threadId));
    if (!thread || thread.status === "removed") return refuse("not_found");
    if (thread.status !== "open") return refuse("thread_locked");
    threadSlowMode = thread.slowMode ?? 0;
  }

  // Length.
  const body = input.body.trim();
  const title = input.title?.trim() ?? "";
  const [postLimits, chatLimits] = await Promise.all([
    getSetting(db, "post_limits"),
    getSetting(db, "chat_limits"),
  ]);
  const maxBody = input.kind === "chat" ? chatLimits.maxLength : POST_BODY_MAX;
  if (body.length > maxBody) return refuse("too_long");
  if (input.kind === "thread" && title.length > THREAD_TITLE_MAX) {
    return refuse("too_long");
  }

  // Rate limits and slow mode.
  if (input.kind === "chat") {
    const slow = Math.max(chatLimits.slowModeSeconds[tier], threadSlowMode);
    if (slow > 0) {
      const [last] = await db
        .select({ createdAt: chatMessages.createdAt })
        .from(chatMessages)
        .where(
          and(
            eq(chatMessages.threadId, input.threadId!),
            eq(chatMessages.authorUserId, viewer.userId),
          ),
        )
        .orderBy(desc(chatMessages.createdAt))
        .limit(1);
      if (last) {
        const nextAt = new Date(last.createdAt.getTime() + slow * 1000);
        if (nextAt > now) return refuse("slow_mode", secondsUntil(now, nextAt));
      }
    }
  } else {
    const windowMs = postLimits.windowSeconds * 1000;
    const since = new Date(now.getTime() - windowMs);
    const limit =
      input.kind === "thread"
        ? postLimits[tier].threads
        : postLimits[tier].replies;
    const recent =
      input.kind === "thread"
        ? await db
            .select({ createdAt: threads.createdAt })
            .from(threads)
            .where(
              and(
                eq(threads.authorUserId, viewer.userId),
                gt(threads.createdAt, since),
              ),
            )
            .orderBy(asc(threads.createdAt))
        : await db
            .select({ createdAt: posts.createdAt })
            .from(posts)
            .where(
              and(
                eq(posts.authorUserId, viewer.userId),
                eq(posts.isOpening, false),
                gt(posts.createdAt, since),
              ),
            )
            .orderBy(asc(posts.createdAt));
    if (recent.length >= limit) {
      // Trying again works once enough of the window's rows have aged out.
      const freeing = recent[recent.length - limit];
      const at = freeing
        ? new Date(freeing.createdAt.getTime() + windowMs)
        : new Date(now.getTime() + windowMs);
      return refuse("rate_limited", secondsUntil(now, at));
    }
  }

  // Links and mentions.
  const allowedLinks = postLimits[tier].links;
  const links = linksIn(`${title}\n${body}`).length;
  if (allowedLinks !== null && links > allowedLinks) {
    return refuse(allowedLinks === 0 ? "links_not_allowed" : "too_many_links");
  }
  if (mentionedNames(body).length > postLimits.mentionsPerPost) {
    return refuse("too_many_mentions");
  }

  // Duplicates: the same post twice. Chat repeats itself by nature.
  if (input.kind !== "chat") {
    const since = new Date(
      now.getTime() - postLimits.duplicateWindowHours * 3_600_000,
    );
    const [dupe] = await db
      .select({ id: posts.id })
      .from(posts)
      .where(
        and(
          eq(posts.authorUserId, viewer.userId),
          gt(posts.createdAt, since),
          sql`btrim(${posts.body}) = ${body}`,
        ),
      )
      .limit(1);
    if (dupe) return refuse("duplicate");
  }

  // The hard-rule filters.
  const rules = await db
    .select({
      id: filterRules.id,
      pattern: filterRules.pattern,
      matchType: filterRules.matchType,
      effect: filterRules.effect,
      scope: filterRules.scope,
    })
    .from(filterRules)
    .where(
      and(
        eq(filterRules.active, true),
        inArray(filterRules.scope, ["all", "titles", "chat"]),
      ),
    );
  const hits = [
    ...(input.kind === "thread" ? matchFilters(rules, "title", title) : []),
    ...matchFilters(rules, input.kind === "chat" ? "chat" : "body", body),
  ];
  if (hits.some((h) => h.effect === "block")) return refuse("blocked");

  const spoilerTitle =
    categoryKind === "race_weekend" &&
    looksLikeSpoilerTitle(title, await spoilerNames(db));

  return {
    ok: true,
    hold: hits.some((h) => h.effect === "hold_for_review"),
    flags: hits,
    spoilerTitle,
  };
}
