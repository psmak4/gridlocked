import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PointsPill } from "./points-pill";

describe("PointsPill", () => {
  it("renders its README example", () => {
    const html = renderToString(<PointsPill points={38} status="final" />);
    expect(html).toContain("38 pts");
  });

  it("shows the word Final, and is final by default", () => {
    expect(renderToString(<PointsPill points={38} />)).toContain(">Final<");
  });

  it("shows the word Provisional, with a dashed outline", () => {
    const html = renderToString(
      <PointsPill points={38} status="provisional" />,
    );
    expect(html).toContain(">Provisional<");
    expect(html).toContain("border-dashed");
  });
});
