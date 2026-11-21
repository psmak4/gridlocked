import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS, AUDIT_GROUPS, type AuditAction } from "./actions";
import type { AuditEntry } from "./log";

describe("AUDIT_ACTIONS (M8 Task 4)", () => {
  it("every AUDIT_ACTIONS entry has a label and a group", () => {
    const entries = Object.entries(AUDIT_ACTIONS);
    expect(entries.length).toBeGreaterThan(30);
    for (const [action, { label, group }] of entries) {
      expect(action).toMatch(/^[a-z_]+(\.[a-z_]+)+$/);
      expect(label.trim()).not.toBe("");
      // Words, starting with a capital: the screen shows it as is.
      expect(label).toMatch(/^[A-Z]/);
      expect(Object.keys(AUDIT_GROUPS)).toContain(group);
    }
    // Every moderation action the queue can take has its row.
    for (const action of [
      "moderation.remove",
      "moderation.restore",
      "moderation.chat_ban",
      "moderation.chat_unban",
    ] satisfies AuditAction[]) {
      expect(AUDIT_ACTIONS[action].group).toBe("moderation");
    }
  });

  it("an action that isn't listed doesn't compile", () => {
    const entry: Pick<AuditEntry, "action"> = {
      // @ts-expect-error: not in AUDIT_ACTIONS, so the screen couldn't name it.
      action: "made.up",
    };
    expect(entry.action in AUDIT_ACTIONS).toBe(false);
  });
});
