import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) =>
  readFileSync(join(process.cwd(), "public", file), "utf8");

describe("the app manifest and service worker", () => {
  it("the manifest has a name, icons and display standalone", () => {
    const manifest = JSON.parse(read("manifest.webmanifest")) as {
      name?: string;
      short_name?: string;
      display?: string;
      start_url?: string;
      icons?: { src: string; sizes: string; type: string }[];
    };
    expect(manifest.name).toBe("Gridlocked");
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/");
    const sizes = (manifest.icons ?? []).map((i) => i.sizes);
    expect(sizes).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    for (const icon of manifest.icons ?? []) {
      expect(() => read(icon.src.replace(/^\//, ""))).not.toThrow();
    }
  });

  it("the service worker handles push and clicks, and caches nothing", () => {
    const sw = read("sw.js");
    expect(sw).toContain('addEventListener("push"');
    expect(sw).toContain('addEventListener("notificationclick"');
    expect(sw).not.toMatch(/caches\.|addEventListener\("fetch"/);
  });
});
