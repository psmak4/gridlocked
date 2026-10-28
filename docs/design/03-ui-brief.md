# Gridlocked — UI/UX Brief (phase 3)

**Status:** Approved 2026-10-27 (phase 3 of 5 complete). The design system and all five waves are in Claude Design and linked below.
**Date:** 2026-10-27
**Builds on:** [01-high-level-design.md](01-high-level-design.md) (HLD) and [02-data-model.md](02-data-model.md) (DM), both approved 2026-10-27.

The screens are designed in **Claude Design** (the Design artifact type), mobile-first. Your account has no saved design system, so phase 3 starts by creating Gridlocked's own system. The designs then become the source of design tokens for Tailwind and shadcn/ui (HLD §11.5).

## Fixed constraints from earlier phases
- **Mobile-first web app, installable as a PWA.** No native apps (HLD §1). Desktop gets wider layouts of the same screens. The admin and moderation screens are the exception: they're designed desktop-first, because staff work at a desk.
- **No F1 marks** (HLD §13.4):
  - no "F1" or "Formula 1" in the brand;
  - no F1, FIA or team logos, and no driver photos;
  - team colors as simple accents only;
  - an "unofficial, not affiliated" disclaimer site-wide;
  - data attribution to Jolpica and OpenF1 in the footer and on data pages (HLD §13.2).
- **Our own chip names and rules text** (HLD §5.4). They're proposed below.
- **Spoiler-safe by default** for logged-out visitors (HLD §7.3). Spoiler states are designed for every screen that can reveal a result, not added afterwards.
- **No live timing** (HLD §7.2). Live views are chat and session status only.
- **Accessibility:** WCAG 2.1 AA as the baseline, which means:
  - contrast;
  - touch targets of at least 44 px;
  - keyboard and screen-reader support through Radix;
  - no meaning carried by color alone. Team colors always appear with a name or short code.
- **Ad-ready but ad-free:** layouts reserve ad slots that stay empty at launch (HLD §16.4, DM 6.9).

## Screen inventory
**Wave 1: Foundation**
1. **Design system:**
   - color tokens (light and dark), type scale, spacing and radii;
   - the icon style;
   - core components: buttons, inputs, cards, list rows, tabs, bottom navigation, sheets, toasts, badges, team-color chips, points pills, the spoiler blur and reveal pattern, and empty states.

**Wave 2: The riskiest mobile screens**
2. **Team builder:**
   - 5 drivers and 2 constructors under the cap;
   - prices, bank and team value;
   - picking the Boost;
   - the transfer counter and penalty preview;
   - playing a chip;
   - inactive-driver warnings;
   - the lock countdown;
   - save conflicts ("your other device saved changes").
3. **Live session thread:**
   - chat mode: flat, newest at the bottom, slow-mode feedback;
   - discussion mode: nested replies about 4 levels deep, then "continue thread";
   - archived chat replay.
4. **Spoiler states:** generic titles, hidden results, comments, chat and scores, the "mark as watched" action, and the logged-out reveal toggle.

**Wave 3: Weekend and game**
5. **Home and event hub:** the weekend timeline, session statuses (including TBC, delayed, suspended and cancelled), lock countdown, and the session threads.
6. **Points breakdown:** line by line, per session.
   - base lines;
   - Boost, x3, Autopilot and No Negative lines;
   - transfer penalty;
   - provisional versus final;
   - "corrected by stewards / admin" notes.
7. **Leagues:** my leagues, standings (paged, with the tiebreak note), creating a league (including mini-league ranges), joining by code, and the auto leagues.
8. **Prices and the pool:** price changes, the published formula explained, ownership percentages.

**Wave 4: Community and account**
9. **Forum:** category list, thread list (hot and new), the composer (link and embed rules by trust level), reporting.
10. **Notifications:** the bell, grouped replies, broadcasts, push opt-in.
11. **Sign-up and onboarding:**
    - email, magic link or Discord;
    - age confirmation and terms;
    - favorite team, driver and country;
    - spoiler preference;
    - verification-pending state, for when email is delayed by the daily cap.
12. **Profile and settings:** trust level, reputation, username change rules, notification preferences, data export, account deletion.

**Wave 5: Staff (desktop-first)**
13. **Results review queue and overrides:** result changes, provider-after-manual entry, the scoring dry-run diff and approval.
14. **Moderation queue:** content snapshots, actions, user history.
15. **Admin:** the calendar and lock times, seats and availability, prices, rulesets, settings, feature flags and the audit log.

**States designed for every screen where they apply:**
- loading and empty;
- before the first race;
- locked;
- provisional versus final;
- cancelled event;
- deleted user;
- offline (PWA);
- the free-tier "service paused" fallback page (HLD §11.4).

## Order and how reviews work
- **One wave at a time,** each reviewed before the next. Wave 2 comes straight after the foundation, because if the team builder or live thread doesn't work on a phone, it changes everything else.
- Each wave is one Design artifact with phone-size artboards, plus desktop artboards where the layout really differs.
- You comment on the artifact, and changes go in before the next wave starts.

## Proposed chip names (our own; same mechanics as HLD §5.4)
These are working names, to be checked with your lawyer alongside the brand (HLD §13.3).

| Official name (reference only) | Proposed | Why |
|---|---|---|
| Autopilot | **Strategist** | The pit wall picks your best Boost after the fact |
| x3 Boost | **Overdrive** | A bigger boost for one driver |
| No Negative | **Safety Car** | Neutralizes the bad stuff for a weekend |
| Wildcard | **Rebuild** | Start the team over, within budget |
| Limitless | **Blank Cheque** | Money's no object for one race |
| Final Fix | **Late Call** | One change after qualifying, before the race |

## Look options (2026-10-27)
You asked to see the options before choosing. They're on the canvas [Gridlocked look options](https://claude.ai/artifact/ErBFUXLZqnxPw95ZFx1o4F) (private to you). All of them show the same team-builder screen, with sample prices and points that are only illustrative:
- **Row 1:** four looks, each in its natural theme. A: Pit wall (dark). B: Race-day energy (dark). C: Clean editorial (light). D: Retro motorsport (light).
- **Row 2:** the same four in the other theme.
- **Row 3:** bold team colors instead of accents, shown on A and C.

Every board also has Tweaks, for theme and team colors, so any look can be flipped either way.

## Decisions (2026-10-27, yours)
| Question | Decision |
|---|---|
| Look | **B · Race-day energy:** bold condensed display type, a strong countdown block, chunky rounded cards, one hot accent plus a yellow for the budget and Boost |
| Theme | **Follow the device.** Dark and light are designed to the same standard, with a manual switch in settings. **Light is the fallback** when a device doesn't say (changed 2026-10-27, yours) |
| Team colors | **Bold:** rows tinted in team color, with a solid team badge. See row 3 of the canvas, which now includes B in both themes |
| Chip names | **As proposed:** Strategist, Overdrive, Safety Car, Rebuild, Blank Cheque, Late Call. To be checked by your lawyer with the brand |

**Your guiding rule: "easy to read, not a busy dashboard."** Every screen in phase 3 is checked against it:
- **One main number per row or card,** such as the price. Everything else is secondary and smaller, never a third column of figures.
- **Plain words before numbers:** "1 of 2 free transfers", not "1/2 FT".
- **Fewer things on screen:** at most about 7 items before a "see more". Detail lives one tap away, for example the points breakdown, not the team screen.
- **Bold team colors are kept as tints,** with a solid badge for identity, and never more than one strong color per row. Big blocks of the hot accent are kept for the single most important thing on a screen, such as the countdown or the Save button.
- **Contrast and size:** body text at least 15 px, numbers at least 16 px, and WCAG AA contrast in both themes, including text on team-color tints.

## Wave 1: design system (drafted 2026-10-27)
The system is in Claude Design as [Gridlocked](https://claude.ai/artifact/PUXqoEEV5XrSJtsfELx7b9) (private to you). It holds:
- **Tokens:**
  - 17 colors in dark (first and fallback) and light;
  - 3 font families from Google Fonts: Anton for display, Barlow for text, Barlow Semi Condensed for numbers;
  - 11 text styles;
  - 6 spacing steps, 4 radii and 1 shadow.

  Every color pairing is checked for WCAG AA in both themes, including text on team tints for all 11 teams of 2026.
- **Brand book:**
  - voice and copy rules;
  - the "keeping it simple" rules;
  - color, type, spacing and shape;
  - team colors (bold tints, auto-contrast badges);
  - spoilers, iconography and accessibility.
- **14 components with live previews:**
  - Button, Badge, TeamBadge, AssetRow;
  - CountdownBlock, BudgetMeter, PointsPill;
  - Tabs, BottomNav;
  - SpoilerCover, TextField, Sheet, Toast, EmptyState.

**Calls I made, to check:**
- ~~Dark is the first theme and the fallback.~~ You changed this: light is the fallback.
- One heat block per screen.
- Team tints are 22% in dark and 12% in light. 12% is what keeps light-mode text at AA on the reddest teams.
- The spoiler cover **replaces** content rather than blurring it.
- Toasts disappear after 4 seconds.
- The countdown ticks every second only in the last 10 minutes.

**Not in wave 1:** the screens themselves (wave 2 onward), a logo (it waits for the trademark check), and the desktop side menu (wave 3).

## Wave 2: the riskiest mobile screens (drafted 2026-10-27)
The screens are on the canvas [Gridlocked wave 2](https://claude.ai/artifact/6ffGHC4QcgEgRZv6pGgwfU) (private to you). Every board uses the design system's real components, light first, with a Dark tweak on each. The sample weekend is round 13, the Italian Grand Prix. Prices and points are illustrative.

| Row | Boards |
|---|---|
| Team builder | Ready to save · Over the cap with an extra transfer · Pick a replacement driver · Chips sheet · Locked, with qualifying scores hidden |
| Session thread | Live chat (slow mode) · Discussion (nested replies, votes, chat replay, results link) |
| Spoiler protection | Weekend hub with qualifying not watched · Qualifying thread hidden until watched |
| Dark theme | Team builder · Live chat |

**What you can click (Play):**
- Bearman's row opens the driver picker.
- Chips opens the chip sheet, and Cancel goes back.
- On the hub, "Mark as watched" or "Show it" reveals the qualifying score.
- The Qualifying session row opens its hidden thread, and revealing it shows the discussion.
- On the locked screen, the score reveals the same way.

**Calls I made, to check:**
- **Save stays visible.** The Save and Chips buttons sit in a fixed bar above the nav, so Save is always on screen while the list scrolls.
- **Over the cap,** one plain sentence says what's wrong and what to do. A second line explains the transfer penalty. Save is disabled.
- **The driver picker** shows about 7 rows, with "See all 22":
  - drivers you can't afford stay visible, untinted, with "$0.4M over budget";
  - Hadjar shows "Out this race" (his real 2026 absence in rounds 12–14).
- **Chips** live in one sheet with a sentence each. Late Call shows "Opens after qualifying" until it can be used.
- **After lock,** prices are replaced by a hidden qualifying score. The action becomes "Play Late Call".
- **Live chat** is flat, newest at the bottom, with no bottom nav. Send waits out slow mode, and there's no live timing. New messages arrive every few seconds rather than instantly (HLD decision 19, 2026-10-28), so the screen doesn't promise "live" speed.
- **Discussion** replies indent up to 3 levels, then "Continue thread". Results are a link, not shown inline, so the thread itself stays spoiler-light.
- **"Show it" versus "Mark as watched":** Show it reveals just this item. Mark as watched reveals that session everywhere. The hidden thread explains the difference in two lines.

## Wave 3: weekend and game (drafted 2026-10-27)
The screens are on the canvas [Gridlocked wave 3](https://claude.ai/artifact/BbF1XbqGJnSS9SwGRh1pHD) (private to you). It uses the same design system and rules as wave 2. The sample week is before round 19, the Mexico City Grand Prix, with points from round 18. Numbers, usernames and results are illustrative.

| Row | Boards |
|---|---|
| Home and the race weekend | Home in race week · Weekend hub before lock (your time or track time) · Session row states (a reference: scheduled, TBC, live, delayed, red flag, hidden, watched, ended early, cancelled) |
| Points breakdown | One weekend, by session, with a correction note · Driver points line by line (sheet) |
| Leagues | My leagues (yours and automatic) · Standings with the tiebreak explained · Create a league (mini-league range) · Join with a code (sheet) |
| Prices | Price changes (going up / going down, your team value) · How prices work (worked example) |
| Desktop | League standings with the side menu: the desktop app shell |
| Dark theme | Home |

**What you can click (Play):**
- From Home: the weekend, your season (which opens the breakdown) and leagues.
- In the breakdown: Antonelli's row opens his line-by-line sheet.
- In Leagues: Join and Create.
- In Prices: "How prices work".
- Tabs switch on every screen that has them.

**Calls I made, to check:**
- **Home** keeps to about 5 blocks: the next weekend, the lock countdown, your season, 3 leagues and 2 hot threads. Everything else is one tap away.
- **The weekend hub** shows session times in your time by default, with a Track switch. Qualifying carries a "Locks team" badge.
- **The breakdown** splits by session using tabs:
  - one row per driver or team, with one number and a plain reason ("P3 · gained 3 places");
  - boosts and the transfer penalty in their own section;
  - a correction explained in one sentence at the top.
- **Standings** show the tiebreak in words under the table, rather than as a symbol. Your row is outlined.
- **Mini-leagues** are made by choosing "Some races" in Create, with From/To rounds. The team you enter is chosen at create or join time, since you can have up to 3.
- **Prices:**
  - "How prices work" uses a worked example marked "Example numbers", because the real constants are calibrated before launch (DM 3.5);
  - team value is shown in words ("up $1.0M since last race").
- **Desktop:** the side menu replaces the bottom nav, with the same items plus Notifications. Tables become real tables, and a side card sums up your position. It stacks to one column at phone width.

## Wave 4: community and account (drafted 2026-10-27)
The screens are on the canvas [Gridlocked wave 4](https://claude.ai/artifact/V1zQ2UffcabkH67GNgJiSS) (private to you). It uses the same design system and rules. Usernames, posts and numbers are illustrative.

| Row | Boards |
|---|---|
| Forum | Categories · Threads in a category (pinned weekend threads, a hidden spoiler thread) · New thread (spoiler title check) · Report (sheet) |
| Notifications | The list (unread, grouped replies, spoiler-safe scores, a correction, moderation) · Turn on push (sheet) |
| Sign-up and onboarding | Choose a way in · Sign up with email · Check your email (with the "busy day" queue message) · Favorites · Spoiler choice |
| Profile and settings | Profile (trust level in plain words) · Settings · Delete account |
| Dark theme | Thread list |

**What you can click (Play):**
- Forum to thread list to "New thread", or "…" opens Report.
- The bell opens Notifications, and the push card opens the push sheet.
- Sign-up runs through email, check-email, favorites and spoilers, then finishes.
- Profile opens Settings, and Settings opens Delete account.
- Tabs, team picks, report reasons and spoiler options all switch.

**Calls I made, to check:**
- **Sign-up leads with Discord.** It's the primary button because it doesn't use the 100-a-day email allowance. Email and magic link come second and third.
  - The sign-up screen also uses the cover's heat-and-checker artwork, a deliberate exception to "one heat block per screen" for this brand moment.
- **Age** is a single "I'm 16 or older" checkbox. Terms, privacy and community rules are accepted together.
  - The bot check is a placeholder box for the Cloudflare Turnstile widget.
- **"Check your email"** lets people look around and build a team before confirming. Posting and chat wait for confirmation. On busy days it says emails are queued and offers Discord.
- **Onboarding** is 2 short steps after the account: favorites (team, driver, optional country), then spoilers ("Hide results until I've watched" is preselected, with a live example).
- **The spoiler title check** warns when a new thread's title may give away a result and offers "Contains spoilers for qualifying" (on by default once warned).
- **Trust levels** show as a plain name ("Member") with one sentence on what it allows and how to reach the next level. The numbers stay internal.
- **Delete account** spells out your choice of "always anonymize":
  - posts stay as "deleted user";
  - teams leave leagues;
  - leagues you run stay open;
  - personal data is erased.

  It offers a data download first, needs your username typed, and confirms by email.
- **Switches** use native checkboxes on these boards. The design system has since gained a Switch component (wave 5), which replaces them when the screens are built.

## Wave 5: staff screens (drafted 2026-10-27)
The screens are on the canvas [Gridlocked wave 5](https://claude.ai/artifact/1jEacvWbtfdQ1DNo9Yv52D) (private to you). They're desktop-first pages, 1440 wide, with a staff side menu. Each stacks to one column on a narrow screen.

**Added to the design system:** a **Switch** component, for on/off settings and feature flags. It's in the system's Forms group with guidelines and a preview. It fills the gap noted in wave 4.

| Row | Boards |
|---|---|
| Results and scoring | Review queue (team change, missing driver, event missing from the provider, uncertain event match, sources disagree) · Session results and corrections · Scoring fix dry run |
| Moderation | Moderation queue (spoiler title, spam held by filter, abuse in chat, copyright) |
| Season data | Calendar and lock times · Drivers, seats and availability · Price update |
| Settings and history | Settings (feature flags, free-tier usage, results pipeline) · Audit log |

**What you can click (Play):**
- The side menu moves between all nine boards.
- In both queues, picking an item swaps the detail panel.
- Switches and tabs work.

**Calls I made, to check:**
- **One review queue for everything a human must decide.** Each item shows what was found, the evidence from each source, and what it holds up ("Scoring is held for Dutch GP qualifying and the race"). It also offers 2–3 plain actions, and a reason that goes into the audit log. The real 2026 cases are the examples:
  - the Lawson/Tsunoda swap;
  - Hadjar missing from the results;
  - Bahrain removed from the calendar;
  - the event moved to Sepang.
- **Corrections** are shown as a layer on top of provider data. Each lists what changed and when, and needs a reason that players see. The screen says how many teams a re-score touches.
- **The scoring fix dry run** comes before any re-score. It shows teams affected, events, the biggest change and league leaders who'd change, then the biggest changes by team, with **Approve and re-score** or **Discard**.
- **Moderation** shows a snapshot of what was posted when it was first reported, the reports by reason, and the author's history. The note to the author is visible to them and can be appealed. "Keep it" closes the reports.
- **Lock times** follow their session unless set by hand. The screen states the rule that a lock can never move into the past.
- **Seats** are listed as date ranges ("21 Aug (rd 12) – 13 Sep (rd 14)"). Availability is edited per event and is clearly labelled warnings-only. Seats after round 14 aren't shown, because the mockup doesn't assume what happened next.
- **Price update** shows each asset's inputs (last-3 average, what its price expects, how it did) next to the change, with **Publish prices**. It also states the carry-over rule if prices miss the lock.
- **Settings:**
  - Ads and notification emails are shown locked off, with the reason.
  - The free-tier usage meters warn at 70% (HLD §11.4).
  - The results pipeline timings are editable.
- **The audit log** is read-only and filterable, and says it stores no emails or IPs.

**Not designed (left to build time):** the rulesets editor, user lookup, and league admin. They reuse these same patterns: a table, a detail panel, a reason, and the audit log.

