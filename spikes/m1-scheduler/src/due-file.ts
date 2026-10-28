// The published due-times file (HLD §4.5). The tick reads it every minute so
// it can decide whether to wake Postgres without touching Postgres.
export type DueFile = { version: 1; generated_at: string; next_due_at: string | null };

export type ParsedDueFile = { ok: true; file: DueFile } | { ok: false; reason: "missing" | "malformed" };

// An ISO-8601 instant with an explicit offset, matching app_now()'s rule.
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function isInstant(value: unknown): value is string {
  return typeof value === "string" && ISO_INSTANT.test(value) && !Number.isNaN(Date.parse(value));
}

export function parseDueFile(text: string | null): ParsedDueFile {
  if (text === null) return { ok: false, reason: "missing" };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof data !== "object" || data === null) return { ok: false, reason: "malformed" };
  const { version, generated_at, next_due_at } = data as Record<string, unknown>;
  if (version !== 1 || !isInstant(generated_at)) return { ok: false, reason: "malformed" };
  if (next_due_at !== null && !isInstant(next_due_at)) return { ok: false, reason: "malformed" };
  return { ok: true, file: { version: 1, generated_at, next_due_at } };
}

export function nextDueFile(pendingRunAts: Date[], now: Date): DueFile {
  const earliest = pendingRunAts.reduce<Date | null>((min, t) => (min === null || t < min ? t : min), null);
  return { version: 1, generated_at: now.toISOString(), next_due_at: earliest?.toISOString() ?? null };
}
