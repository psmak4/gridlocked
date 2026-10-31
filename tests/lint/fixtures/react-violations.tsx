// Deliberately breaks one React or accessibility rule per line marked below.
// Linted only by tests/lint/react-rules.test.ts.
import { useState } from "react";

export function Violations({
  items,
  open,
}: {
  items: string[];
  open: boolean;
}) {
  if (open) {
    // react-hooks/rules-of-hooks: a hook called conditionally.
    useState(0);
  }
  return (
    <section>
      {/* jsx-a11y/alt-text: an image with no alt. */}
      <img src="/x.png" />
      {/* jsx-a11y/click-events-have-key-events and no-static-element-interactions. */}
      <div onClick={() => undefined}>Tap</div>
      {/* react/jsx-key: list items with no key. */}
      <ul>
        {items.map((item) => (
          <li>{item}</li>
        ))}
      </ul>
    </section>
  );
}
