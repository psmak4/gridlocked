import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TextField } from "./text-field";

describe("TextField", () => {
  it("renders its label, tied to the input", () => {
    const html = renderToString(<TextField id="name" label="Team name" />);
    expect(html).toContain("Team name");
    expect(html).toMatch(/<label[^>]*for="name"/);
    expect(html).toMatch(/<input[^>]*id="name"/);
  });

  it("is disabled when asked to", () => {
    expect(renderToString(<TextField id="n" label="Name" disabled />)).toMatch(
      /<input[^>]*disabled/,
    );
  });

  it("is at least 44 px, 48 with 16 px text", () => {
    const html = renderToString(<TextField id="n" label="Name" />);
    expect(html).toContain("min-h-[48px]");
    expect(html).toContain("text-[16px]");
  });

  it("links the hint and the error with aria-describedby", () => {
    const html = renderToString(
      <TextField id="n" label="Name" hint="3 to 20 letters" error="Taken" />,
    );
    const describedBy = html.match(/aria-describedby="([^"]*)"/)?.[1] ?? "";
    expect(describedBy.split(" ")).toEqual(["n-hint", "n-error"]);
    expect(html).toMatch(/id="n-hint"[^>]*>3 to 20 letters/);
    expect(html).toMatch(/id="n-error"[^>]*>Taken/);
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain("text-fall");
  });

  it("has no description or invalid flag when clean", () => {
    const html = renderToString(<TextField id="n" label="Name" />);
    expect(html).not.toContain("aria-describedby");
    expect(html).not.toMatch(/\saria-invalid="/);
  });
});

describe("TextField describedby merge", () => {
  it("keeps a caller's aria-describedby beside the hint and error", () => {
    const html = renderToString(
      <TextField
        id="n"
        label="Name"
        hint="Hint"
        error="Err"
        aria-describedby="outside"
      />,
    );
    expect(html).toContain('aria-describedby="outside n-hint n-error"');
  });
});
