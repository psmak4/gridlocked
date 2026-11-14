import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SpoilerCover } from "./spoiler-cover";

describe("SpoilerCover", () => {
  it("renders its README example", () => {
    const html = renderToString(
      <SpoilerCover
        hidden
        title="Race — results are in"
        body="You haven't marked this session as watched."
        onReveal={() => {}}
        onMarkWatched={() => {}}
      >
        <p>P1 Norris</p>
      </SpoilerCover>,
    );
    expect(html).toContain("Race — results are in");
    expect(html).toContain("marked this session as watched");
    expect(html).toContain("bg-veil");
  });

  it("hidden leaves its children out of the DOM", () => {
    const html = renderToString(
      <SpoilerCover hidden onReveal={() => {}}>
        <p>P1 Norris</p>
      </SpoilerCover>,
    );
    expect(html).not.toContain("Norris");
    expect(html).not.toContain("P1");
  });

  it("shows only its children when not hidden", () => {
    const html = renderToString(
      <SpoilerCover hidden={false} title="Race — results are in">
        <p>P1 Norris</p>
      </SpoilerCover>,
    );
    expect(html).toBe("<p>P1 Norris</p>");
  });

  it("has Show it as a real button", () => {
    expect(renderToString(<SpoilerCover hidden onReveal={() => {}} />)).toMatch(
      /<button[^>]*>Show it</,
    );
  });

  it("Mark as watched is absent without onMarkWatched", () => {
    expect(
      renderToString(<SpoilerCover hidden onReveal={() => {}} />),
    ).not.toContain("Mark as watched");
  });

  it("Mark as watched is a real button with onMarkWatched", () => {
    expect(
      renderToString(
        <SpoilerCover hidden onReveal={() => {}} onMarkWatched={() => {}} />,
      ),
    ).toMatch(/<button[^>]*>Mark as watched</);
  });

  it("has a neutral default title", () => {
    expect(renderToString(<SpoilerCover hidden />)).toContain(
      "Spoiler protected",
    );
  });
});
