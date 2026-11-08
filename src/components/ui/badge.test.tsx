import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Badge } from "./badge";

describe("Badge", () => {
  it("renders its label", () => {
    expect(renderToString(<Badge>2x</Badge>)).toContain("2x");
  });

  it("styles each tone from tokens", () => {
    expect(renderToString(<Badge>a</Badge>)).toContain("bg-surface-sunken");
    expect(renderToString(<Badge tone="boost">a</Badge>)).toContain("bg-volt");
    expect(renderToString(<Badge tone="caution">a</Badge>)).toContain(
      "border-caution",
    );
    expect(renderToString(<Badge tone="live">a</Badge>)).toContain("bg-heat");
  });

  it("has no interactive state, so no disabled state", () => {
    expect(renderToString(<Badge>a</Badge>)).not.toContain("disabled");
  });

  it("is a plain label, not a control, so it has no 44 px target", () => {
    expect(renderToString(<Badge>a</Badge>)).toMatch(/^<span/);
  });
});
