import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  LOCAL_TURNSTILE_TOKEN,
  TURNSTILE_SCRIPT_URL,
  Turnstile,
  loadTurnstileScript,
  startTurnstile,
} from "./turnstile";

type FakeScript = {
  src: string;
  async: boolean;
  onload: (() => void) | null;
  onerror: (() => void) | null;
};

function fakeDocument() {
  const added: FakeScript[] = [];
  const doc = {
    createElement: () =>
      ({ src: "", async: false, onload: null, onerror: null }) as FakeScript,
    head: { appendChild: (script: FakeScript) => void added.push(script) },
    querySelector: (selector: string) =>
      added.find((s) => selector.includes(s.src)) ?? null,
  };
  return { doc: doc as unknown as Document, added };
}

describe("Turnstile", () => {
  it("the local stand-in gives a token", () => {
    const onToken = vi.fn();
    const loadScript = vi.fn();
    startTurnstile({
      mode: "local",
      onToken,
      loadScript,
      container: null,
      siteKey: undefined,
    });
    expect(onToken).toHaveBeenCalledExactlyOnceWith(LOCAL_TURNSTILE_TOKEN);
    // It needs no network.
    expect(loadScript).not.toHaveBeenCalled();
  });

  it("the local stand-in is labelled, and needs no script", () => {
    const html = renderToString(<Turnstile local onToken={() => {}} />);
    expect(html).toContain("Bot check");
    expect(html).toContain("local stand-in");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("challenges.cloudflare.com");
  });

  it("the real widget's script loads only on pages that need it", async () => {
    // Rendering the component on the server adds no script: the script is
    // added by an effect, in the browser, on a page that mounts the widget.
    const html = renderToString(
      <Turnstile local={false} siteKey="site" onToken={() => {}} />,
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("challenges.cloudflare.com");

    // Nothing is loaded until asked, and then once however often it is asked.
    const { doc, added } = fakeDocument();
    expect(added).toHaveLength(0);
    const first = loadTurnstileScript(doc);
    const second = loadTurnstileScript(doc);
    expect(added).toHaveLength(1);
    expect(added[0]!.src).toBe(TURNSTILE_SCRIPT_URL);
    expect(TURNSTILE_SCRIPT_URL).toContain("render=explicit");
    added[0]!.onload?.();
    await Promise.all([first, second]);
  });

  it("the real widget renders into its container and passes the token on", () => {
    const render = vi.fn(
      (_el: unknown, options: { callback: (t: string) => void }) => {
        options.callback("real-token");
        return "widget-1";
      },
    );
    const remove = vi.fn();
    const onToken = vi.fn();
    const loadScript = vi.fn(async () => ({ render, remove }));
    const container = {} as HTMLElement;
    return startTurnstile({
      mode: "widget",
      onToken,
      loadScript,
      container,
      siteKey: "site-key",
    }).then((stop) => {
      expect(render).toHaveBeenCalledOnce();
      expect(render.mock.calls[0]![1]).toMatchObject({ sitekey: "site-key" });
      expect(onToken).toHaveBeenCalledWith("real-token");
      stop();
      expect(remove).toHaveBeenCalledWith("widget-1");
    });
  });
});
