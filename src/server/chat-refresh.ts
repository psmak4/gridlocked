/**
 * `GET /api/chat/$threadId?after=<windowStartIso>` (HLD §11.2, decision 19):
 * a session thread's latest visible messages up to the end of that window.
 *
 * The answer is the same for everyone, so it is `public, s-maxage=<window>`
 * with no `Vary`: the CDN serves a whole crowd from one read. It never looks
 * at the cookie, so a signed-in request and a logged-out one get the same
 * bytes. A spoiler-scoped thread is kept off a screen that hasn't revealed
 * it by the client, which never asks.
 */
import { z } from "zod";
import { chatState, chatUpTo } from "@/community/chat";
import { threadMode } from "@/community/session-threads";
import { getSetting } from "@/settings";
import { withNoStore } from "./no-store";
import type { ServerDb } from "./db";

export type RunWithNow = <T>(
  fn: (db: ServerDb, now: Date) => Promise<T>,
) => Promise<T>;

const uuid = z.uuid();

/** How far ahead of the server a client's window may start (clock skew). */
const AHEAD_MS = 10_000;
/** How far behind: a page asks for the window it's in, give or take. */
const BEHIND_MS = 60_000;

const refused = (status: number, text: string) =>
  withNoStore(new Response(text, { status }));

export async function chatRefreshResponse(
  request: Request,
  threadId: string,
  run: RunWithNow,
): Promise<Response> {
  if (!uuid.safeParse(threadId).success) return refused(404, "Not found");
  // One address a window: `after` alone, spelled as `toISOString()` spells
  // it. Each other spelling or extra parameter would be its own CDN entry.
  const params = new URL(request.url).searchParams;
  const after = params.get("after");
  const startMs = after ? Date.parse(after) : Number.NaN;
  if (
    !Number.isFinite(startMs) ||
    [...params.keys()].join() !== "after" ||
    new Date(startMs).toISOString() !== after
  )
    return refused(400, "Bad request");

  return run(async (db, now) => {
    // Chat turned off by staff: no session thread has a live chat to refresh.
    if (!(await getSetting(db, "feature_flags")).chat) {
      return refused(404, "Not found");
    }
    const limits = await getSetting(db, "chat_limits");
    const size = limits.windowSeconds * 1000;
    // Only window starts, and not far ahead or behind: each URL is one
    // cache entry, so nobody can make the CDN miss by inventing new ones.
    if (
      startMs % size !== 0 ||
      startMs > now.getTime() + AHEAD_MS ||
      startMs < now.getTime() - BEHIND_MS
    ) {
      // With the server's clock, so a client that drifted can line up again.
      return withNoStore(
        Response.json(
          { error: "bad_window", now: now.toISOString() },
          { status: 400 },
        ),
      );
    }
    const state = await chatState(db, threadId);
    if (!state || state.kind !== "session" || state.status === "removed") {
      return refused(404, "Not found");
    }
    const end = new Date(startMs + size);
    const messages = await chatUpTo(db, threadId, end, limits.refreshLimit);
    const mode = threadMode(
      now,
      state.sessionStatus
        ? {
            status: state.sessionStatus,
            awaitingResults: state.awaitingResults,
          }
        : null,
      state,
    );
    return new Response(
      JSON.stringify({
        messages,
        mode,
        now: now.toISOString(),
        windowStart: after,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": `public, s-maxage=${limits.windowSeconds}`,
        },
      },
    );
  });
}
