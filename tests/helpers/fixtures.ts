import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Reads a recorded fixture under tests/fixtures/ as parsed JSON. */
export function readFixture(path: string): unknown {
  const file = fileURLToPath(new URL(`../fixtures/${path}`, import.meta.url));
  return JSON.parse(readFileSync(file, "utf8"));
}
