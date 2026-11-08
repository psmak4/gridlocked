import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { useHydrated } from "./use-hydrated";

function Probe() {
  return <span>{String(useHydrated())}</span>;
}

describe("useHydrated", () => {
  it("is false on the server", () => {
    expect(renderToString(<Probe />)).toContain("false");
  });
});
