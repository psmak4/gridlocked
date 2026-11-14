import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppShell, NoGame } from "./app-shell";

/** Each `<nav>` in the page: the side menu, then the bottom nav. */
function navs(html: string): string[] {
  return [...html.matchAll(/<nav[\s\S]*?<\/nav>/g)].map((m) => m[0]);
}

/** The labels of a nav's links, in order. */
const labels = (nav: string) =>
  [...nav.matchAll(/<a[^>]*>(?:<svg[\s\S]*?<\/svg>)?([^<]+)<\/a>/g)].map(
    (m) => m[1],
  );

describe("AppShell", () => {
  it("the active item has aria-current", () => {
    const html = renderToString(
      <AppShell active="team">
        <p>Body</p>
      </AppShell>,
    );
    const found = navs(html);
    expect(found).toHaveLength(2);
    for (const nav of found) {
      expect(nav.match(/aria-current="page"/g)).toHaveLength(1);
      expect(nav).toMatch(/href="\/team"[^>]*aria-current="page"/);
    }
    expect(html).toContain("<main");
    expect(html).toContain("<p>Body</p>");
  });

  it("four items in order", () => {
    const html = renderToString(
      <AppShell active="home">
        <p>Body</p>
      </AppShell>,
    );
    const [side, bottom] = navs(html);
    expect(labels(bottom!)).toEqual(["Home", "Team", "Leagues", "Profile"]);
    // The side menu has the wordmark first, then the same four.
    expect(labels(side!)).toEqual([
      "GRIDLOCKED",
      "Home",
      "Team",
      "Leagues",
      "Profile",
    ]);
    for (const href of ["/", "/team", "/leagues", "/profile"]) {
      expect(bottom).toContain(`href="${href}"`);
    }
  });
});

describe("NoGame", () => {
  it("says the game isn't open yet", () => {
    const html = renderToString(<NoGame />);
    expect(html).toContain("No game yet");
    expect(html).toContain("The game opens before the first race.");
  });
});
