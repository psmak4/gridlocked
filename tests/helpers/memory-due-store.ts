import type { DueStore } from "@/jobs/due-times";

/** An in-memory `DueStore` that records its writes, for tests. */
export function createMemoryDueStore(initial: Record<string, string> = {}) {
  const objects = new Map(Object.entries(initial));
  const puts: { key: string; body: string }[] = [];
  const store: DueStore = {
    async get(key) {
      return objects.get(key) ?? null;
    },
    async put(key, body) {
      puts.push({ key, body });
      objects.set(key, body);
    },
  };
  return { store, objects, puts };
}
