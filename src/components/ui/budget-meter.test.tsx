import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BudgetMeter } from "./budget-meter";

describe("BudgetMeter", () => {
  it('reads "$97.8M of $100M"', () => {
    const html = renderToString(<BudgetMeter spent={97.8} />);
    expect(html).toContain(">$97.8M of $100M<");
    expect(html).toContain('role="meter"');
    expect(html).toContain('aria-valuetext="$97.8M of $100M"');
    expect(html).toContain("bg-volt");
  });

  it("uses the team's own cap", () => {
    expect(renderToString(<BudgetMeter spent={50} cap={102.3} />)).toContain(
      "$50M of $102.3M",
    );
  });

  it('reads "Over by $1.4M" over the cap, with the heat bar', () => {
    const html = renderToString(<BudgetMeter spent={101.4} />);
    expect(html).toContain(">Over by $1.4M<");
    expect(html).toContain('aria-valuetext="Over by $1.4M"');
    expect(html).toContain("text-fall");
    expect(html).toContain("bg-heat");
    expect(html).not.toContain("bg-volt");
  });
});
