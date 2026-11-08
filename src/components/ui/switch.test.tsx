import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Switch } from "./switch";

describe("Switch", () => {
  it("renders its label and description", () => {
    const html = renderToString(
      <Switch id="spoilers" label="Hide results" description="Until watched" />,
    );
    expect(html).toContain("Hide results");
    expect(html).toContain("Until watched");
  });

  it("has role switch", () => {
    expect(renderToString(<Switch id="s" label="Hide" />)).toContain(
      'role="switch"',
    );
  });

  it("reflects the checked state", () => {
    expect(
      renderToString(<Switch id="s" label="Hide" defaultChecked />),
    ).toContain('aria-checked="true"');
  });

  it("is disabled when asked to", () => {
    expect(renderToString(<Switch id="s" label="Hide" disabled />)).toMatch(
      /disabled/,
    );
  });

  it("has a row at least 48 px tall", () => {
    expect(renderToString(<Switch id="s" label="Hide" />)).toContain(
      "min-h-[48px]",
    );
  });
});
