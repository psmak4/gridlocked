import { expect, type APIRequestContext } from "@playwright/test";

/**
 * Marks an account's address verified and sets its trust level, through the
 * local-only `/api/test/community` hook: a new account is TL0 and unverified,
 * and the forum needs it verified to post.
 */
export async function setTrust(
  request: APIRequestContext,
  email: string,
  trustLevel: 0 | 1 | 2 | 3,
): Promise<void> {
  const response = await request.post("/api/test/community", {
    data: { email, trustLevel },
  });
  expect(response.status(), await response.text()).toBe(200);
  expect(((await response.json()) as { changed: number }).changed).toBe(1);
}
