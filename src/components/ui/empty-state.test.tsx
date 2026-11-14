import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "./button";
import { EmptyState } from "./empty-state";

describe("EmptyState", () => {
  it("renders its README example", () => {
    const html = renderToString(
      <EmptyState
        title="No leagues yet"
        body="Leagues you join or create show here."
        action={<Button>Join with a code</Button>}
      />,
    );
    expect(html).toMatch(/<h2[^>]*>No leagues yet<\/h2>/);
    expect(html).toContain("Leagues you join or create show here.");
    expect(html).toContain("Join with a code");
  });

  it("takes a heading level", () => {
    expect(
      renderToString(<EmptyState title="No teams yet" headingLevel={3} />),
    ).toMatch(/<h3[^>]*>No teams yet<\/h3>/);
  });
});
