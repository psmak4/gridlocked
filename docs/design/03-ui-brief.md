# Gridlocked — UI/UX Brief (phase 3)

**Status:** Look and feel decided 2026-10-27. Wave 1 (design system) is next.
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
| Theme | **Follow the device.** Dark and light are designed to the same standard, with a manual switch in settings |
| Team colors | **Bold:** rows tinted in team color, with a solid team badge. See row 3 of the canvas, which now includes B in both themes |
| Chip names | **As proposed:** Strategist, Overdrive, Safety Car, Rebuild, Blank Cheque, Late Call. To be checked by your lawyer with the brand |

**Your guiding rule: "easy to read, not a busy dashboard."** Every screen in phase 3 is checked against it:
- **One main number per row or card,** such as the price. Everything else is secondary and smaller, never a third column of figures.
- **Plain words before numbers:** "1 of 2 free transfers", not "1/2 FT".
- **Fewer things on screen:** at most about 7 items before a "see more". Detail lives one tap away, for example the points breakdown, not the team screen.
- **Bold team colors are kept as tints,** with a solid badge for identity, and never more than one strong color per row. Big blocks of the hot accent are kept for the single most important thing on a screen, such as the countdown or the Save button.
- **Contrast and size:** body text at least 15 px, numbers at least 16 px, and WCAG AA contrast in both themes, including text on team-color tints.
