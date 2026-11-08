import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Toast } from "./toast";

describe("Toast", () => {
  it("renders its message as a status", () => {
    const html = renderToString(<Toast>Team saved</Toast>);
    expect(html).toContain("Team saved");
    expect(html).toContain('role="status"');
  });

  it("renders its action, disabled until hydrated", () => {
    const html = renderToString(
      <Toast actionLabel="Undo" onAction={() => {}}>
        Team saved
      </Toast>,
    );
    expect(html).toContain("Undo");
    expect(html).toMatch(/<button[^>]*disabled/);
  });

  it("has no action button without a label", () => {
    expect(renderToString(<Toast>Saved</Toast>)).not.toContain("<button");
  });

  it("is at least 48 px, with a 44 px action", () => {
    const html = renderToString(
      <Toast actionLabel="Undo" onAction={() => {}}>
        Saved
      </Toast>,
    );
    expect(html).toContain("min-h-[48px]");
    expect(html).toContain("min-h-[44px]");
  });
});
