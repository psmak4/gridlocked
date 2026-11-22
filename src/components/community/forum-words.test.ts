import { describe, expect, it } from "vitest";
import { ago, refusalWords, repliesWords, threadMeta } from "./forum-words";

const NOW = Date.parse("2026-06-07T18:00:00Z");
const before = (ms: number) => new Date(NOW - ms).toISOString();

describe("forum words", () => {
  it("ago reads like wave 4's rows", () => {
    expect(ago(before(20_000), NOW)).toBe("now");
    expect(ago(before(5 * 60_000), NOW)).toBe("5 min");
    expect(ago(before(3 * 3_600_000), NOW)).toBe("3 h");
    expect(ago(before(2 * 86_400_000), NOW)).toBe("2 d");
    // A clock a little ahead of the server's still reads "now".
    expect(ago(new Date(NOW + 5_000).toISOString(), NOW)).toBe("now");
  });

  it("a thread row's meta line", () => {
    expect(repliesWords(1)).toBe("1 reply");
    expect(repliesWords(86)).toBe("86 replies");
    expect(repliesWords(1284)).toBe("1,284 replies");
    expect(
      threadMeta(
        {
          author: "late_braker",
          replyCount: 86,
          lastActivityAt: before(3 * 3_600_000),
        },
        NOW,
      ),
    ).toBe("late_braker · 86 replies · 3 h");
    // A system thread has no author.
    expect(
      threadMeta(
        { author: null, replyCount: 0, lastActivityAt: before(60_000) },
        NOW,
      ),
    ).toBe("0 replies · 1 min");
  });

  it("every refusal has words, and a wait says how long", () => {
    expect(
      refusalWords({ ok: false, error: "rate_limited", retryAfterSeconds: 90 }),
    ).toBe("You're posting fast. Try again in 2 minutes.");
    expect(
      refusalWords({ ok: false, error: "slow_mode", retryAfterSeconds: 6 }),
    ).toBe("You can send again in 6 seconds.");
    expect(refusalWords({ ok: false, error: "links_not_allowed" })).toBe(
      "New accounts can't post links yet.",
    );
    expect(refusalWords({ ok: false, error: "thread_locked" })).toBe(
      "This thread is locked.",
    );
  });
});

describe("the mute's words", () => {
  it('"You\'re muted until <time>" names the end, and "until lifted" when there\'s none', () => {
    expect(
      refusalWords(
        { ok: false, error: "muted", until: "2026-06-08T19:00:00.000Z" },
        "Europe/London",
      ),
    ).toBe("You're muted until 8 Jun, 20:00, so you can't post.");
    expect(refusalWords({ ok: false, error: "muted", until: null })).toBe(
      "You're muted until it's lifted, so you can't post.",
    );
  });
});
