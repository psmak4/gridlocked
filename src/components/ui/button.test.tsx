import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "./button";

describe("Button", () => {
  it("renders its label", () => {
    expect(renderToString(<Button>Save team</Button>)).toContain("Save team");
  });

  it("is disabled in server HTML, until hydrated", () => {
    expect(renderToString(<Button>Save</Button>)).toMatch(
      /<button[^>]*disabled/,
    );
  });

  it("stays disabled when asked to", () => {
    expect(renderToString(<Button disabled>Save</Button>)).toMatch(
      /<button[^>]*disabled/,
    );
  });

  it("is a plain, enabled link as a staticLink", () => {
    const html = renderToString(
      <Button staticLink href="/sign-in">
        Sign in
      </Button>,
    );
    expect(html).toMatch(/<a[^>]*href="\/sign-in"/);
    expect(html).not.toMatch(/\sdisabled[\s=>]/);
  });

  it("is at least 44 px, and 52 px when large", () => {
    expect(renderToString(<Button>Go</Button>)).toContain("min-h-[44px]");
    expect(renderToString(<Button size="l">Go</Button>)).toContain(
      "min-h-[52px]",
    );
  });

  it("fills the width as a block", () => {
    expect(renderToString(<Button block>Go</Button>)).toContain("w-full");
  });

  it("uses the heat fill for primary", () => {
    expect(renderToString(<Button>Go</Button>)).toContain("bg-heat");
  });
});
