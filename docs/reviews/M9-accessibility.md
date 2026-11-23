# M9 accessibility review

M9 Task 8 (#295), 2026-11-22. What was checked, what it found, and what was
done about each finding.

## What was checked

| Pass | How | Where |
| --- | --- | --- |
| The route sweep | axe-core, WCAG 2.1 A and AA tags (`wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`), at 1440 and 390 wide | `e2e/fantasy/a11y-sweep.spec.ts` |
| The keyboard pass | Playwright, keyboard only: every control is reached with Tab (or the arrow keys inside a widget) and must show a focus ring | `e2e/fantasy/keyboard.spec.ts` |
| The VoiceOver pass | Not done (see below) | — |

**The sweep** covers every page route in `src/routeTree.gen.ts` except two
that only redirect (`/forgot-password` to `/reset-password`, and `/staff` to
the first staff screen; both land on routes the sweep checks). It runs as
three roles:

- logged out: the public pages;
- a player with a team and a league, once before round 1's lock and again
  after the race (a locked team, points, spoiler covers, the race's
  threads), plus `/team` before the first team and `/welcome` for an account
  that hasn't finished signing up;
- an admin with staff tools unlocked, with an item in the review queue and a
  reported post in the moderation queue.

Each role starts from its known pages and follows the in-site links it finds,
so the routes with an id in them (`/t/$threadId`, `/leagues/$slug`,
`/staff/results/$sessionId` and the rest) are reached the way a person
reaches them. A route a role should reach and didn't fails the sweep, so a
route can't drop out of it unnoticed.

**The keyboard pass** covers the beta's main flows: sign up, build a team and
see it locked, a price reveal, chat in a race thread, and reporting a post.

## Findings

| # | Found by | Finding | WCAG | Done |
| --- | --- | --- | --- | --- |
| 1 | Sweep | The home page's season card link had an `aria-label` ("Your season · *team*") that didn't contain its visible text, so a speech-input user saying what they see wouldn't match it (axe `label-content-name-mismatch`). | 2.5.3 Label in Name (A) | Fixed in a1a3f95: the link takes its name from its content. |
| 2 | Keyboard pass | No control on the site showed a focus ring. Tailwind v4's `outline-none` sets `--tw-outline-style: none`, and `focus-visible:outline-2` draws with that variable, so the ring had a width and a colour but no style. axe doesn't check focus visibility, so only the keyboard pass caught it. | 2.4.7 Focus Visible (AA) | Fixed in 82bf780: every focus ring also says `focus-visible:outline-solid` (69 controls). The keyboard pass now checks the ring on every control it reaches. |

After both fixes the sweep finds no WCAG 2.1 A or AA violation on any route,
at either width, for any role, and all five keyboard flows pass.

Seen and not a finding:

- A radio group (the report reasons) is one tab stop: Tab reaches its first
  choice and the arrow keys move and check within it. That is the expected
  pattern, and the keyboard pass uses it.
- The post's "More" menu opens with Enter and its items are reached with the
  arrow keys, as a menu should be.

## The VoiceOver pass: not done

The plan asks for a VoiceOver pass over the same flows. It needs a person
listening to macOS VoiceOver (or iOS VoiceOver on a phone), which can't be
automated here, so it hasn't been done. It is owed by the owner before the
beta opens (Task 13). What to listen for, flow by flow:

- **Sign up:** each field and checkbox is read with its label; an error is
  read when it appears.
- **Build a team:** the picker sheet is announced as a dialog; each driver
  and constructor reads with its price; the budget left is read after a
  pick; "Team saved" is announced.
- **The lock:** the locked team reads as locked, with when it unlocks.
- **A reveal:** the "Show it" cover reads as hiding the price changes, and
  the changes are read once shown.
- **Chat:** new messages are announced without moving focus; Send reads as
  a button.
- **A report:** the More menu and the report sheet are announced; the
  "Thanks. A moderator will take a look." status is read.

Write what you hear in this file under a "VoiceOver pass" heading, with a
finding for anything that reads wrong.
