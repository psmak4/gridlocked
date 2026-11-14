import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TeamBadge } from "./team-badge";

describe("TeamBadge", () => {
  it("renders its README example: the code on a solid team block", () => {
    const html = renderToString(
      <TeamBadge code="MCL" color="#ff8000" teamName="McLaren" />,
    );
    expect(html).toContain(">MCL<");
    expect(html).toContain('title="McLaren"');
    expect(html).toContain("background-color:#ff8000");
    expect(html).toContain("color:#0b0b1e");
  });

  it("switches to white text where navy doesn't pass", () => {
    expect(renderToString(<TeamBadge code="FER" color="#e8002d" />)).toContain(
      "color:#ffffff",
    );
  });

  it("draws a ring on the surface as an outline", () => {
    const html = renderToString(
      <TeamBadge code="MCL" color="#ff8000" variant="outline" />,
    );
    expect(html).toContain("border-color:#ff8000");
    expect(html).toContain("bg-surface");
    expect(html).toContain("text-ink");
    expect(html).not.toContain("background-color:#ff8000");
  });

  it("is 46 px, and 38 by 28 when small", () => {
    expect(renderToString(<TeamBadge code="MCL" color="#ff8000" />)).toContain(
      "size-[46px]",
    );
    const small = renderToString(
      <TeamBadge code="MCL" color="#ff8000" size="s" />,
    );
    expect(small).toContain("w-[38px]");
    expect(small).toContain("h-[28px]");
  });
});
