import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BottomNav } from "./bottom-nav";

const items = [
  { id: "home", label: "Home", href: "/", icon: "home" as const },
  { id: "team", label: "Team", href: "/team", icon: "team" as const },
  {
    id: "leagues",
    label: "Leagues",
    href: "/leagues",
    icon: "leagues" as const,
  },
  {
    id: "profile",
    label: "Profile",
    href: "/profile",
    icon: "profile" as const,
  },
];

describe("BottomNav", () => {
  it("renders its README example: icon and label for each item", () => {
    const html = renderToString(<BottomNav items={items} active="home" />);
    expect(html).toMatch(/^<nav[^>]*aria-label="Main"/);
    for (const item of items) {
      expect(html).toContain(`href="${item.href}"`);
      expect(html).toContain(`>${item.label}<`);
    }
    expect(html.match(/<svg/g)).toHaveLength(4);
  });

  it('marks the active item with aria-current="page"', () => {
    const html = renderToString(<BottomNav items={items} active="team" />);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/href="\/team"[^>]*aria-current="page"/);
  });

  it("falls back to the item's id for its icon", () => {
    const html = renderToString(
      <BottomNav
        items={[{ id: "forum", label: "Forum", href: "/forum" }]}
        active=""
      />,
    );
    expect(html).toContain("<svg");
  });

  it("is 60 px tall", () => {
    expect(renderToString(<BottomNav items={items} active="home" />)).toContain(
      "h-[60px]",
    );
  });
});
