import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Sheet } from "./sheet";

describe("Sheet", () => {
  it("renders its README example as a static panel when open isn't given", () => {
    const html = renderToString(
      <Sheet title="Play Overdrive">
        <p>Double one driver&apos;s points this weekend.</p>
      </Sheet>,
    );
    expect(html).toContain("Play Overdrive");
    expect(html).toContain("Double one driver");
    expect(html).toContain('aria-label="Play Overdrive"');
    expect(html).toContain("shadow-[var(--shadow-sheet)]");
  });

  it("renders nothing while closed", () => {
    const html = renderToString(
      <Sheet title="Play Overdrive" open={false} onClose={() => {}}>
        <p>Secret body</p>
      </Sheet>,
    );
    expect(html).not.toContain("Secret body");
  });
});
