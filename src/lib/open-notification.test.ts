import { describe, expect, it } from "vitest";
import { openNotification } from "./open-notification";

describe("opening a notification", () => {
  const item = { id: "n1", unread: true, href: "/forum/t/abc" };

  it("a failed mark-read still opens the notification", async () => {
    const went: string[] = [];
    await openNotification(item, {
      markRead: async () => {
        throw new Error("offline");
      },
      go: (href) => went.push(href),
    });
    expect(went).toEqual(["/forum/t/abc"]);
  });

  it("marks an unread one read first, and leaves a read one alone", async () => {
    const calls: string[] = [];
    const moves = {
      markRead: async (id: string) => {
        calls.push(`read ${id}`);
      },
      go: (href: string) => {
        calls.push(`go ${href}`);
      },
    };
    await openNotification(item, moves);
    await openNotification({ ...item, unread: false }, moves);
    expect(calls).toEqual(["read n1", "go /forum/t/abc", "go /forum/t/abc"]);
  });
});
