import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LegalText } from "./legal-document";

describe("LegalText", () => {
  it("the beta notice shows the approved text, not the draft placeholder", () => {
    const html = renderToString(<LegalText kind="beta" />);
    expect(html).toContain("Gridlocked is in a closed beta.");
    expect(html).toContain("It replays the 2026 season.");
    expect(html).toContain("Your account may not carry over.");
    expect(html).toContain("Gridlocked is an independent fan site.");
    expect(html).not.toContain("DRAFT 1");
  });

  it("the other documents are still marked as drafts", () => {
    for (const kind of ["terms", "privacy", "community_rules"]) {
      expect(renderToString(<LegalText kind={kind} />)).toContain("DRAFT 1");
    }
  });
});
