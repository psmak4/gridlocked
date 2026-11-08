import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Checkbox } from "./checkbox";

describe("Checkbox", () => {
  it("renders its label", () => {
    expect(
      renderToString(<Checkbox id="tos" label="I accept the terms" />),
    ).toContain("I accept the terms");
  });

  it("is disabled when asked to", () => {
    expect(
      renderToString(<Checkbox id="tos" label="Terms" disabled />),
    ).toMatch(/disabled/);
  });

  it("has a row at least 48 px tall", () => {
    expect(renderToString(<Checkbox id="tos" label="Terms" />)).toContain(
      "min-h-[48px]",
    );
  });

  it("links the hint and the error with aria-describedby", () => {
    const html = renderToString(
      <Checkbox
        id="tos"
        label="Terms"
        hint="Read them first"
        error="Required"
      />,
    );
    expect(html).toContain('aria-describedby="tos-hint tos-error"');
    expect(html).toContain("Required");
    expect(html).toContain("text-fall");
  });

  it("uses a line-strong border and an ink fill when checked", () => {
    const html = renderToString(<Checkbox id="tos" label="Terms" />);
    expect(html).toContain("border-line-strong");
    expect(html).toContain("data-checked:bg-ink");
  });
});
