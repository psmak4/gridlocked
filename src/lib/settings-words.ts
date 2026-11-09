/**
 * Words the profile and settings pages show (M5 task 13). Pure, so the server
 * can format a date in the person's time zone and the page shows that text
 * as it is: no clock or time zone is read in the browser.
 */

export type TrustWords = { name: string; allows: string };

/**
 * Trust levels in plain words (DM 6.5, HLD §7.4, ruling 51f): the name, and
 * one sentence on what it allows. The numbers stay internal.
 */
export const TRUST_WORDS: readonly TrustWords[] = [
  {
    name: "New",
    allows:
      "New means you can reply in threads and chat, while starting threads and posting links come with time.",
  },
  {
    name: "Basic",
    allows:
      "Basic means you can start threads, downvote and put one link in each post.",
  },
  {
    name: "Member",
    allows:
      "Member means you can post links freely, with higher limits, and your flags count for more.",
  },
  {
    name: "Regular",
    allows:
      "Regular means your flags can hide a post until a moderator looks, and you can retitle spoiler threads.",
  },
];

export function trustWords(level: number): TrustWords {
  return TRUST_WORDS[level] ?? TRUST_WORDS[0]!;
}

function zoneOrUtc(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone });
    return timeZone;
  } catch {
    return "UTC";
  }
}

function yearIn(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { year: "numeric", timeZone }).format(
    date,
  );
}

/** "26 Nov", or "3 Jan 2027" when the year isn't `now`'s, in `timeZone`. */
export function dayLabel(date: Date, timeZone: string, now: Date): string {
  const zone = zoneOrUtc(timeZone);
  const sameYear = yearIn(date, zone) === yearIn(now, zone);
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: zone,
  }).format(date);
}

/** "Mar 2026", for when someone joined. */
export function monthLabel(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    month: "short",
    year: "numeric",
    timeZone: zoneOrUtc(timeZone),
  }).format(date);
}

/** "Email and Discord": a list of names, joined as a sentence would. */
export function andList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
