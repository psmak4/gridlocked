import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConsentFields } from "./sign-up-fields";

const boxes = (beta: boolean, termsError = false) =>
  renderToString(
    <ConsentFields
      ageConfirmed={false}
      accepted={false}
      onAge={() => {}}
      onAccepted={() => {}}
      ageError={false}
      termsError={termsError}
      beta={beta}
    />,
  );

describe("ConsentFields", () => {
  it("names the beta notice, with its link, only while one is in force", () => {
    const withBeta = boxes(true);
    expect(withBeta).toContain('href="/legal/beta"');
    expect(withBeta).toContain("Beta notice");

    const without = boxes(false);
    expect(without).not.toContain("/legal/beta");
    expect(without).toContain('href="/legal/community_rules"');
  });

  it("an unchecked box's error names the beta notice too while it's on the box", () => {
    expect(boxes(true, true)).toContain(
      "Accept the terms, privacy policy, community rules and beta notice to continue.",
    );
    expect(boxes(false, true)).toContain(
      "Accept the terms, privacy policy and community rules to continue.",
    );
  });
});
