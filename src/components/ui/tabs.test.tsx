import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Tabs } from "./tabs";

const items = [
  { id: "drivers", label: "Drivers" },
  { id: "constructors", label: "Constructors" },
];

describe("Tabs", () => {
  it("renders its README example as a labelled tab list", () => {
    const html = renderToString(
      <Tabs label="Pick from" items={items} value="drivers" />,
    );
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="Pick from"');
    expect(html).toContain("Drivers");
    expect(html).toContain("Constructors");
  });

  it("marks the current value selected", () => {
    const html = renderToString(
      <Tabs label="Pick from" items={items} value="constructors" />,
    );
    expect(html).toMatch(/aria-selected="true"[^>]*>Constructors</);
    expect(html).toMatch(/aria-selected="false"[^>]*>Drivers</);
  });

  it("has tabs at least 44 px tall", () => {
    expect(
      renderToString(<Tabs label="Pick from" items={items} value="drivers" />),
    ).toContain("min-h-[44px]");
  });
});
