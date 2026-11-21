import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { staffMenu, type StaffScreen } from "@/staff/menu";
import { StaffShell } from "./staff-shell";

/** The nine boards' screens, in the board's order, with Users after Moderation. */
const SCREENS: StaffScreen[] = [
  {
    id: "review",
    label: "Review queue",
    href: "/staff/review",
    group: "results",
    role: "admin",
  },
  {
    id: "scoring",
    label: "Scoring",
    href: "/staff/scoring",
    group: "results",
    role: "admin",
  },
  {
    id: "moderation",
    label: "Moderation",
    href: "/staff/moderation",
    group: "moderation",
    role: "moderator",
  },
  {
    id: "users",
    label: "Users",
    href: "/staff/users",
    group: "moderation",
    role: "moderator",
  },
  {
    id: "calendar",
    label: "Calendar",
    href: "/staff/calendar",
    group: "season",
    role: "admin",
  },
  {
    id: "settings",
    label: "Settings",
    href: "/staff/settings",
    group: "history",
    role: "admin",
  },
  {
    id: "audit",
    label: "Audit log",
    href: "/staff/audit",
    group: "history",
    role: "admin",
  },
];

/** The labels of the menu's links, in order, less any count. */
const labels = (html: string) =>
  [...html.matchAll(/<a [^>]*data-slot="staff-menu-item"[^>]*>([^<]+)/g)].map(
    (m) => m[1],
  );

const render = (
  role: "admin" | "moderator",
  current: string,
  counts: Record<string, number> = {},
) =>
  renderToString(
    <StaffShell
      menu={staffMenu(role, counts, SCREENS)}
      current={current}
      who={{ username: role === "admin" ? "preston" : "mod_kate", role }}
    >
      <p>Body</p>
    </StaffShell>,
  );

describe("StaffShell", () => {
  it("the menu shows a moderator Moderation and Users only", () => {
    expect(staffMenu("moderator", {}, SCREENS).map((s) => s.id)).toEqual([
      "moderation",
      "users",
    ]);
    const html = render("moderator", "moderation");
    expect(labels(html)).toEqual(["Moderation", "Users"]);
    expect(html).not.toContain("Audit log");
    expect(html).not.toContain("Season data");
  });

  it("an admin sees every screen in the board's order, grouped", () => {
    const html = render("admin", "audit");
    expect(labels(html)).toEqual(SCREENS.map((s) => s.label));
    for (const group of [
      "Results and scoring",
      "Moderation",
      "Season data",
      "Settings and history",
    ]) {
      expect(html).toContain(group);
    }
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/href="\/staff\/audit"[^>]*aria-current="page"/);
  });

  it("the wordmark, the counts, and who is signed in", () => {
    const html = render("admin", "review", { review: 4, moderation: 0 });
    expect(html).toContain("GRIDLOCKED · STAFF");
    // A count shows when there's something waiting, and is read out.
    expect(html).toMatch(
      /Review queue<span class="sr-only">, 4 waiting<\/span>/,
    );
    expect(html).not.toContain("0 waiting");
    expect(html).toContain("Signed in as preston · admin · 2-step on");
    expect(html).toContain("<main");
    expect(html).toContain("<p>Body</p>");
  });
});
