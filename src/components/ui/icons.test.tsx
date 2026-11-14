import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Icon, iconNames } from "./icons";

describe("Icon", () => {
  it("has the launch set", () => {
    expect(iconNames).toEqual([
      "home",
      "team",
      "leagues",
      "forum",
      "profile",
      "bell",
    ]);
  });

  it.each(iconNames)(
    "%s is a 24 px stroke icon, hidden from screen readers",
    (name) => {
      const html = renderToString(<Icon name={name} />);
      expect(html).toContain('width="24"');
      expect(html).toContain('height="24"');
      expect(html).toContain('viewBox="0 0 24 24"');
      expect(html).toContain('stroke="currentColor"');
      expect(html).toContain('stroke-width="2.2"');
      expect(html).toContain('fill="none"');
      expect(html).toContain('aria-hidden="true"');
      expect(html).toContain("<path");
    },
  );
});
