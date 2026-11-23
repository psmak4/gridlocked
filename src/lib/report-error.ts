/**
 * Errors to Sentry, scrubbed (M9 Task 10, decision 3). One scrubber,
 * `scrub`, is the browser SDK's `beforeSend` and runs on every event the
 * server and the tick build here: it keeps what says *what* failed (the
 * error's class, a constant code, the route pattern, the stack's frames, the
 * release) and drops everything that could carry a value (messages, request
 * data, the user, breadcrumbs' data and messages, extra, and tags beyond the
 * allowed ones). It builds a new event from an allowlist, so a field Sentry
 * adds later stays behind until it's listed here.
 *
 * Isomorphic and dependency-free: the tick's bundle and the browser both use it.
 */
import { errorCode } from "@/lib/error-code";

type Frame = {
  filename?: string;
  function?: string;
  module?: string;
  lineno?: number;
  colno?: number;
  in_app?: boolean;
  [key: string]: unknown;
};

type ExceptionValue = {
  type?: string;
  value?: string;
  mechanism?: { type?: string; handled?: boolean; [key: string]: unknown };
  stacktrace?: { frames?: Frame[]; [key: string]: unknown };
  [key: string]: unknown;
};

type Breadcrumb = {
  timestamp?: number;
  category?: string;
  level?: string;
  type?: string;
  [key: string]: unknown;
};

/** The parts of a Sentry event this module reads or writes. */
export type ReportEvent = {
  event_id?: string;
  timestamp?: number;
  platform?: string;
  level?: string;
  release?: string;
  dist?: string;
  environment?: string;
  sdk?: unknown;
  exception?: { values?: ExceptionValue[] };
  breadcrumbs?: Breadcrumb[];
  contexts?: Record<string, unknown>;
  tags?: Record<string, unknown>;
  fingerprint?: string[];
  debug_meta?: unknown;
  [key: string]: unknown;
};

/** The tags kept: each a constant or a route pattern, never a value. */
const TAGS = ["code", "route", "runtime"] as const;
/** The contexts kept: what browser or runtime it was, nothing of the page. */
const CONTEXTS = ["browser", "os", "runtime", "device"] as const;
const CONTEXT_FIELDS = ["name", "version", "family", "model"] as const;

/** A URL without its query string or fragment. */
const bare = (url: string) => url.replace(/[?#].*$/s, "");

/** Only constant-looking strings: a code, or a pattern like `/u/$username`. */
const SAFE_TAG = /^[\w$./#:-]{1,200}$/;

function pick<T extends object>(
  from: T | undefined,
  keys: readonly string[],
): Partial<T> | undefined {
  if (!from || typeof from !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = (from as Record<string, unknown>)[key];
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<T>;
}

function scrubFrame(frame: Frame): Frame {
  const kept = pick(frame, [
    "function",
    "module",
    "lineno",
    "colno",
    "in_app",
    "platform",
    "instruction_addr",
  ]) as Frame;
  if (typeof frame.filename === "string") kept.filename = bare(frame.filename);
  if (typeof frame.abs_path === "string") kept.abs_path = bare(frame.abs_path);
  return kept;
}

function scrubException(value: ExceptionValue): ExceptionValue {
  const out: ExceptionValue = {};
  if (typeof value.type === "string") out.type = value.type;
  if (value.mechanism) {
    out.mechanism = pick(value.mechanism, [
      "type",
      "handled",
      "synthetic",
      "exception_id",
      "parent_id",
      "is_exception_group",
      "source",
    ]);
  }
  const frames = value.stacktrace?.frames;
  if (Array.isArray(frames)) {
    out.stacktrace = { frames: frames.map(scrubFrame) };
  }
  return out;
}

/**
 * The event with only its value-free parts, or null when it isn't an error
 * (a message event has nothing but its message).
 */
export function scrub<E extends ReportEvent>(event: E): E | null {
  const values = event.exception?.values;
  if (!Array.isArray(values) || values.length === 0) return null;
  const out: ReportEvent = pick(event, [
    "type",
    "event_id",
    "timestamp",
    "platform",
    "level",
    "release",
    "dist",
    "environment",
    "sdk",
    "fingerprint",
    "debug_meta",
  ]) as ReportEvent;
  out.exception = { values: values.map(scrubException) };

  const tags: Record<string, string> = {};
  for (const key of TAGS) {
    const value = event.tags?.[key];
    if (typeof value === "string" && SAFE_TAG.test(value)) tags[key] = value;
  }
  if (Object.keys(tags).length > 0) out.tags = tags;

  const contexts: Record<string, unknown> = {};
  for (const key of CONTEXTS) {
    const kept = pick(
      event.contexts?.[key] as Record<string, unknown> | undefined,
      CONTEXT_FIELDS,
    );
    if (kept && Object.keys(kept).length > 0) contexts[key] = kept;
  }
  if (Object.keys(contexts).length > 0) out.contexts = contexts;

  if (Array.isArray(event.breadcrumbs)) {
    out.breadcrumbs = event.breadcrumbs.map(
      (b) => pick(b, ["timestamp", "category", "level", "type"]) as Breadcrumb,
    );
  }
  return out as E;
}

/**
 * An error's class, never its message: its `name`, or its constructor's name
 * when `name` is the generic "Error" (DrizzleQueryError sets none). Both are
 * class names in code, so it stays value-free (Ruling 59).
 */
export function errorName(error: Error): string {
  if (error.name !== "Error") return error.name;
  const constructorName: unknown = error.constructor?.name;
  return typeof constructorName === "string" && constructorName !== ""
    ? constructorName
    : "Error";
}

/** V8's `    at fn (file:line:col)` and `    at file:line:col`. */
const V8_FRAME = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/;

/**
 * The frames of a V8 stack, oldest first as Sentry wants them. Only the
 * `at` lines are read: the lines before them are the message, which can
 * carry a query's parameters.
 */
function framesOf(stack: string | undefined): Frame[] {
  if (!stack) return [];
  const frames: Frame[] = [];
  for (const line of stack.split("\n")) {
    const match = V8_FRAME.exec(line);
    if (!match) continue;
    const [, fn, file, lineno, colno] = match;
    const filename = bare(file!.replace(/^file:\/\//, ""));
    frames.push({
      filename,
      function: fn ?? "?",
      lineno: Number(lineno),
      colno: Number(colno),
      in_app:
        !filename.includes("node_modules") && !filename.startsWith("node:"),
    });
  }
  return frames.reverse();
}

function exceptionOf(error: unknown): ExceptionValue {
  if (!(error instanceof Error)) {
    return {
      type: typeof error,
      mechanism: { type: "generic", handled: true },
    };
  }
  return {
    type: errorName(error),
    mechanism: { type: "generic", handled: true },
    stacktrace: { frames: framesOf(error.stack) },
  };
}

/** 32 hex characters. */
function eventId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A scrubbed event for an error caught on the server or in the tick: its
 * class and its causes' (up to five, the cause first as Sentry lists them),
 * their frames, and its code when it has a constant one.
 */
export function eventFromError(
  error: unknown,
  context: {
    route: string;
    now: Date;
    release?: string;
    environment?: string;
    runtime?: string;
  },
): ReportEvent {
  const chain: unknown[] = [error];
  let next: unknown = error instanceof Error ? error.cause : undefined;
  while (next !== undefined && chain.length < 5) {
    chain.push(next);
    next = next instanceof Error ? next.cause : undefined;
  }
  const code = errorCode(error);
  const event: ReportEvent = {
    event_id: eventId(),
    timestamp: context.now.getTime() / 1000,
    platform: "node",
    level: "error",
    exception: { values: chain.map(exceptionOf).reverse() },
    tags: {
      route: context.route,
      ...(code ? { code } : {}),
      ...(context.runtime ? { runtime: context.runtime } : {}),
    },
    ...(context.release ? { release: context.release } : {}),
    ...(context.environment ? { environment: context.environment } : {}),
  };
  return scrub(event)!;
}

/**
 * The request that sends one event: the DSN's envelope endpoint and the
 * envelope (header, item header, event). Null for a DSN that won't parse.
 */
export function envelopeFor(
  event: ReportEvent,
  dsn: string,
): { url: string; body: string } | null {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return null;
  }
  const projectId = url.pathname.replace(/^\/+|\/+$/g, "");
  if (url.protocol !== "https:" || !url.username || !/^\d+$/.test(projectId)) {
    return null;
  }
  const endpoint = `https://${url.host}/api/${projectId}/envelope/`;
  const body = [
    JSON.stringify({
      event_id: event.event_id,
      dsn,
      sent_at: new Date((event.timestamp ?? 0) * 1000).toISOString(),
    }),
    JSON.stringify({ type: "event" }),
    JSON.stringify(event),
  ].join("\n");
  return { url: endpoint, body };
}
