// Length limits for community text. No imports: the schema, the gate and the
// screens' forms all read these, and the forms ship to the browser.

/** DM 5.4: a post's Markdown source, in characters. */
export const POST_BODY_MAX = 10_000;
/** A thread's title, in characters. */
export const THREAD_TITLE_MAX = 120;
/** DM 5.5: a chat message, in characters. */
export const CHAT_BODY_MAX = 500;
