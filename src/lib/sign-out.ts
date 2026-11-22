/**
 * Signing out of this browser: its push subscription goes first, while the
 * session still counts, so the account stops sending to a browser nobody
 * is signed in on (M9 Task 3). A push that can't be forgotten never stops
 * the sign-out.
 */
export async function signOutHere(moves: {
  forgetPush: () => Promise<unknown>;
  signOut: () => Promise<unknown>;
}): Promise<void> {
  try {
    await moves.forgetPush();
  } catch (error) {
    console.error(
      `push unsubscribe on sign-out failed: ${error instanceof Error ? error.name : "unknown"}`,
    );
  }
  await moves.signOut();
}
