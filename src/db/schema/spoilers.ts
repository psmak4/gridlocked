import { pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { sessions } from "./reference";

// Spoiler state (DM 5.7). Built in M6 so fantasy scores, standings and price
// changes can wait for "Mark as watched"; M7's threads and chat use the same
// table and check (`src/spoilers/reveal.ts`).

/**
 * DM 5.7: "I've watched this; show me everything". One row per user and
 * session, written once (marking again changes nothing). Deleting an account
 * deletes its rows (the personal-data registry, DM 6.7).
 */
export const sessionWatchMarks = pgTable(
  "session_watch_marks",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "restrict" }),
    markedAt: timestamp("marked_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.sessionId] })],
);
