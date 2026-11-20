import { describe, expect, it } from "vitest";
import { renderPost } from "./render";

const tl0 = { linksAllowed: false };
const tl1 = { linksAllowed: true };

describe("renderPost (DM 5.4: Markdown through a strict sanitizer)", () => {
  it("<script> comes out escaped", () => {
    const html = renderPost("Hi <script>alert(1)</script>", tl1);
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
    // Raw HTML of any kind is text.
    expect(renderPost('<img src=x onerror="alert(1)">', tl1)).not.toContain(
      "<img",
    );
    expect(renderPost("<a href='https://x.example'>x</a>", tl1)).not.toContain(
      "<a ",
    );
  });

  it("a javascript: link has no href", () => {
    for (const href of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,hi",
      "vbscript:x",
    ]) {
      const html = renderPost(`[click](${href})`, tl1);
      expect(html, href).not.toContain("href");
      expect(html, href).toContain("click");
    }
  });

  it("a YouTube link on the allow-list stays a link", () => {
    const html = renderPost(
      "[the start](https://www.youtube.com/watch?v=abc&t=10)",
      tl0,
    );
    expect(html).toContain(
      '<a href="https://www.youtube.com/watch?v=abc&amp;t=10" rel="nofollow ugc noopener noreferrer" target="_blank">the start</a>',
    );
    expect(renderPost("<https://youtu.be/abc>", tl0)).toContain(
      'href="https://youtu.be/abc"',
    );
  });

  it("an unknown domain's link stays text for TL0", () => {
    const html = renderPost("[cheap](https://cheap.example/x)", tl0);
    expect(html).not.toContain("<a");
    expect(html).toContain("cheap");
    // From TL1 it's a link.
    expect(renderPost("[cheap](https://cheap.example/x)", tl1)).toContain(
      'href="https://cheap.example/x"',
    );
    // A look-alike host isn't on the allow-list.
    expect(
      renderPost("[x](https://youtube.com.evil.example/x)", tl0),
    ).not.toContain("<a");
  });

  it("an image becomes its alt text, since there are no images in posts", () => {
    const html = renderPost("![a pit stop](https://i.imgur.com/x.png)", tl1);
    expect(html).not.toContain("<img");
    expect(html).toContain("a pit stop");
  });

  it("keeps the everyday formatting", () => {
    const html = renderPost(
      "**Bold**, _italic_, `code`\n\n> quoted\n\n- one\n- two",
      tl0,
    );
    expect(html).toContain("<strong>Bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<li>one</li>");
  });

  it("a link to a page on this site is kept for anyone, and a // link is not", () => {
    expect(renderPost("[Results and points](/weekend)", tl0)).toBe(
      '<p><a href="/weekend">Results and points</a></p>',
    );
    expect(renderPost("[x](//evil.example/a)", tl0)).not.toContain("href");
    // micromark encodes the backslash, which leaves a path on this site.
    expect(renderPost("[x](/\\evil.example)", tl0)).toContain(
      'href="/%5Cevil.example"',
    );
  });

  it("a site link drops its ?show=, so a pasted address reveals nothing", () => {
    expect(renderPost("[x](/t/abc?show=all)", tl0)).toBe(
      '<p><a href="/t/abc">x</a></p>',
    );
    expect(renderPost("[x](/t/abc?post=p1&show=s1#c)", tl0)).toBe(
      '<p><a href="/t/abc?post=p1#c">x</a></p>',
    );
  });
});
