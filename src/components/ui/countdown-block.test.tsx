import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CountdownBlock } from "./countdown-block";

describe("CountdownBlock", () => {
  it("renders its README example on the heat block", () => {
    const html = renderToString(
      <CountdownBlock
        label="Locks in"
        value="1D 04:12"
        stats={[
          { value: "$2.2M", label: "Bank" },
          { value: "1/2", label: "Transfers" },
        ]}
      />,
    );
    expect(html).toContain("Locks in");
    expect(html).toContain("1D 04:12");
    expect(html).toContain("$2.2M");
    expect(html).toContain("Bank");
    expect(html).toContain("Transfers");
    expect(html).toContain("bg-heat");
    expect(html).toContain('aria-label="Locks in 1D 04:12"');
  });

  it("says Locks in by default", () => {
    expect(renderToString(<CountdownBlock value="47:12" />)).toContain(
      "Locks in",
    );
  });

  it("shows at most two stats", () => {
    const html = renderToString(
      <CountdownBlock
        value="LOCKED"
        stats={[
          { value: "1", label: "One" },
          { value: "2", label: "Two" },
          { value: "3", label: "Three" },
        ]}
      />,
    );
    expect(html).toContain("Two");
    expect(html).not.toContain("Three");
  });
});
