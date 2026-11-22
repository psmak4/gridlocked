/**
 * Opening a notification from the list: marked read on the way, but a mark
 * that fails (offline, signed out) never stops the person getting there
 * (M9 Task 3).
 */
export async function openNotification(
  item: { id: string; unread: boolean; href: string },
  moves: {
    markRead: (id: string) => Promise<unknown>;
    go: (href: string) => void;
  },
): Promise<void> {
  if (item.unread) {
    try {
      await moves.markRead(item.id);
    } catch (error) {
      console.error(
        `notification mark-read failed: ${error instanceof Error ? error.name : "unknown"}`,
      );
    }
  }
  moves.go(item.href);
}
