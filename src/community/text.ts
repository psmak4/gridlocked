/**
 * The posting gate's pure text checks: links, mentions, filter rules and the
 * spoiler-title check. No database here, so the composer can run them in the
 * browser as the person types.
 */
import type {
  FILTER_EFFECTS,
  FILTER_MATCH_TYPES,
  FILTER_SCOPES,
} from "@/db/schema";

type FilterEffect = (typeof FILTER_EFFECTS)[number];
type FilterMatchType = (typeof FILTER_MATCH_TYPES)[number];
type FilterScope = (typeof FILTER_SCOPES)[number];

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
