import { describe, expect, it } from "vitest";
import { EMAIL_TEMPLATES } from "@/db/schema";
import { DISCLAIMER, renderEmail } from "./templates";

describe("renderEmail", () => {
  it.each(EMAIL_TEMPLATES)(
    "every template renders, carries its link, and ends with the disclaimer: %s",
    (template) => {
      const url = "https://gridlocked.example/auth/go?token=abc123&x=1";
      const { subject, text, html } = renderEmail(template, { url });
      expect(subject.length).toBeGreaterThan(0);
      expect(text).toContain(url);
      expect(text.trimEnd().endsWith(DISCLAIMER)).toBe(true);
      // The href is escaped, so the `&` is `&amp;` in the HTML.
      expect(html).toContain("token=abc123&amp;x=1");
      expect(html).toContain(DISCLAIMER);
      expect(html.trimEnd()).toMatch(/<\/html>$/);
    },
  );

  it("the disclaimer is the site footer's wording", () => {
    expect(DISCLAIMER).toBe(
      "Unofficial. Not affiliated with Formula 1 or the FIA.",
    );
  });

  it("escapes markup in the link", () => {
    const { html } = renderEmail("magic_link", {
      url: 'https://x.example/"><script>alert(1)</script>',
    });
    expect(html).not.toContain("<script>");
  });
});
