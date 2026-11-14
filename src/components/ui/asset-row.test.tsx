import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AssetRow } from "./asset-row";

const example = {
  code: "MCL",
  teamColor: "#ff8000",
  title: "Norris",
  subtitle: "McLaren",
  figure: "$26.6M",
  delta: 0.2,
  secondary: "38 pts",
};

describe("AssetRow", () => {
  it("renders its README example", () => {
    const html = renderToString(<AssetRow {...example} />);
    expect(html).toContain(">MCL<");
    expect(html).toContain("Norris");
    expect(html).toContain("McLaren");
    expect(html).toContain("$26.6M");
    expect(html).toContain("38 pts");
    expect(html).toContain(" · ");
  });

  it("with delta 0.2 shows ▲0.2 in rise", () => {
    expect(renderToString(<AssetRow {...example} />)).toMatch(
      /class="text-rise"[^>]*>▲0.2</,
    );
  });

  it("with delta -0.1 shows ▼0.1 in fall", () => {
    expect(renderToString(<AssetRow {...example} delta={-0.1} />)).toMatch(
      /class="text-fall"[^>]*>▼0.1</,
    );
  });

  it("is tinted with the team color by default", () => {
    expect(renderToString(<AssetRow {...example} />)).toContain(
      "background-color:color-mix(in srgb, #ff8000 var(--team-tint), var(--surface))",
    );
  });

  it("is untinted when tinted is false", () => {
    const html = renderToString(<AssetRow {...example} tinted={false} />);
    expect(html).not.toContain("color-mix");
    expect(html).toContain("bg-surface-raised");
  });

  it("shows up to two badges", () => {
    const html = renderToString(
      <AssetRow
        {...example}
        badges={[
          { tone: "boost", label: "2x" },
          { tone: "caution", label: "Doubtful" },
          { tone: "neutral", label: "Reserve" },
        ]}
      />,
    );
    expect(html).toContain("2x");
    expect(html).toContain("Doubtful");
    expect(html).not.toContain("Reserve");
  });

  it("is a plain div with no onClick or href", () => {
    const html = renderToString(<AssetRow {...example} />);
    expect(html).toMatch(/^<div/);
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<a");
  });

  it("is a link with an href", () => {
    expect(
      renderToString(<AssetRow {...example} href="/drivers/nor" />),
    ).toMatch(/^<a[^>]*href="\/drivers\/nor"/);
  });

  it("is a button with onClick, disabled until hydrated", () => {
    expect(
      renderToString(<AssetRow {...example} onClick={() => {}} />),
    ).toMatch(/^<button[^>]*type="button"[^>]*disabled/);
  });

  it("is untinted and aria-disabled when disabled", () => {
    const html = renderToString(
      <AssetRow {...example} onClick={() => {}} disabled />,
    );
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toContain("color-mix");
  });

  it("is at least 56 px tall", () => {
    expect(renderToString(<AssetRow {...example} />)).toContain("min-h-[56px]");
  });
});
