/** Lowercase words joined by hyphens: `max_verstappen` -> `max-verstappen`. */
export function kebab(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * `base`, or `base-2`, `base-3`, ... for the first one `isTaken` says is free.
 * Slugs are unique columns, and historical names and ids can clash (DM 1.5).
 */
export async function uniqueSlug(
  base: string,
  isTaken: (slug: string) => Promise<boolean>,
): Promise<string> {
  const root = base === "" ? "item" : base;
  if (!(await isTaken(root))) return root;
  for (let n = 2; ; n++) {
    const candidate = `${root}-${n}`;
    if (!(await isTaken(candidate))) return candidate;
  }
}

/**
 * The form of an event name used to recognise the same event after a rename
 * of the round or a provider's wording change (DM 1.3): lowercase, no
 * accents or punctuation, without "grand prix" or "gp", single spaces.
 */
export function normalizeEventName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\bgrand prix\b/g, " ")
    .replace(/\bgp\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
