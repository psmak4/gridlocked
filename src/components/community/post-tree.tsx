import { useState } from "react";
import type { Writer } from "@/community/writer";
import type { CommunityRefusal } from "@/community/errors";
import type { PostView } from "@/community/read";
import { cn } from "@/lib/utils";
import { ReplyForm } from "./composer";
import { FAILED, ago, refusalWords } from "./forum-words";

export type VoteResult = { ok: true; score: number } | CommunityRefusal;
export type ReplyResult = { ok: true } | CommunityRefusal;

type PostActions = {
  writer: Writer;
  /** No new replies, and no votes, in a locked or archived thread. */
  open: boolean;
  nowMs: number;
  vote: (postId: string, value: -1 | 0 | 1) => Promise<VoteResult>;
  reply: (parentPostId: string | null, body: string) => Promise<ReplyResult>;
  /** Where "Continue thread" goes for a post. */
  continueHref: (postId: string) => string;
};

const iconButton =
  "flex size-[44px] items-center justify-center rounded-radius-m border-0 bg-transparent text-ink-muted outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:cursor-not-allowed disabled:opacity-45 aria-pressed:text-heat-text";

const PLACEHOLDER: Record<PostView["state"], string> = {
  visible: "",
  pending: "",
  deleted: "[deleted]",
  removed: "[removed]",
};

/** Up and down, with the score between them. Optimistic, then the server's score. */
function Votes({ post, actions }: { post: PostView; actions: PostActions }) {
  const [mine, setMine] = useState(post.myVote);
  const [score, setScore] = useState(post.score);
  const [error, setError] = useState<string | null>(null);
  const { writer } = actions;
  const can = writer !== null && writer.canPost && actions.open && !post.mine;
  const cast = (value: -1 | 1) => {
    const next = mine === value ? 0 : value;
    const before = { mine, score };
    setMine(next);
    setScore(score - mine + next);
    setError(null);
    void actions.vote(post.id, next).then(
      (result) => {
        if (result.ok) {
          setScore(result.score);
        } else {
          setMine(before.mine);
          setScore(before.score);
          setError(refusalWords(result));
        }
      },
      () => {
        setMine(before.mine);
        setScore(before.score);
        setError(FAILED);
      },
    );
  };
  return (
    <>
      <button
        type="button"
        className={iconButton}
        aria-label="Upvote"
        aria-pressed={mine === 1}
        disabled={!can}
        onClick={() => cast(1)}
      >
        <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true">
          <path d="M8 3l5 7H3z" fill="currentColor" />
        </svg>
      </button>
      <span
        className="min-w-[2ch] text-center font-numeric text-[14px] font-bold"
        data-score
      >
        {score}
      </span>
      {/* TL0 can upvote but not downvote (DM 5.9). */}
      {writer === null || writer.trustLevel >= 1 ? (
        <button
          type="button"
          className={iconButton}
          aria-label="Downvote"
          aria-pressed={mine === -1}
          disabled={!can}
          onClick={() => cast(-1)}
        >
          <svg viewBox="0 0 16 16" className="size-4" aria-hidden="true">
            <path d="M8 13l5-7H3z" fill="currentColor" />
          </svg>
        </button>
      ) : null}
      {error ? (
        <span role="alert" className="text-[14px] font-semibold text-fall">
          {error}
        </span>
      ) : null}
    </>
  );
}

/** One post: who and when, the text or its placeholder, and what you can do. */
export function PostItem({
  post,
  actions,
  heading,
}: {
  post: PostView;
  actions: PostActions;
  /** The opening post's text sits under the thread's own heading. */
  heading?: boolean;
}) {
  const [replying, setReplying] = useState(false);
  const readable = post.html !== null;
  const canReply =
    !post.isOpening &&
    readable &&
    actions.open &&
    actions.writer !== null &&
    actions.writer.canPost;
  return (
    <article
      aria-label={post.author ? `Post by ${post.author}` : "Post"}
      data-post={post.id}
      className={cn(
        "flex flex-col gap-space-1",
        !heading && "border-l-2 border-line pl-space-3",
      )}
      style={{ marginLeft: post.isOpening ? 0 : (post.depth - 1) * 16 }}
    >
      {readable ? (
        <>
          {/* The opening post's who and when are in the thread's header. */}
          <p
            className={cn(
              "m-0 flex flex-wrap items-center gap-x-space-2 text-[14px] text-ink-muted",
              heading && "sr-only",
            )}
          >
            {post.author ? (
              <span className="font-bold text-ink">{post.author}</span>
            ) : null}
            <span>{ago(post.createdAt, actions.nowMs)}</span>
            {post.edited ? <span>· edited</span> : null}
            {post.state === "pending" ? (
              <span>· Waiting for a moderator</span>
            ) : null}
          </p>
          <div
            className="post-body text-[16px] leading-[24px] break-words [&_a]:font-semibold [&_a]:text-ink [&_a]:underline [&_p]:my-space-1"
            // Rendered by `renderPost`: Markdown through micromark with raw
            // HTML escaped, and only allowed links kept (DM 5.4).
            dangerouslySetInnerHTML={{ __html: post.html! }}
          />
        </>
      ) : (
        <p className="m-0 text-[16px] text-ink-muted italic">
          {PLACEHOLDER[post.state]}
        </p>
      )}
      {readable ? (
        <div className="flex flex-wrap items-center gap-space-1">
          <Votes post={post} actions={actions} />
          {canReply ? (
            <button
              type="button"
              className="min-h-[44px] rounded-radius-m border-0 bg-transparent px-space-2 text-[14px] font-bold text-ink-muted outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
              aria-expanded={replying}
              onClick={() => setReplying((open) => !open)}
            >
              Reply
            </button>
          ) : null}
        </div>
      ) : null}
      {replying ? (
        <ReplyForm
          label={`Reply to ${post.author ?? "this post"}`}
          onSubmit={async (body) => {
            const result = await actions.reply(post.id, body);
            if (result.ok) setReplying(false);
            return result;
          }}
          onCancel={() => setReplying(false)}
        />
      ) : null}
      {post.moreReplies > 0 ? (
        <a
          href={actions.continueHref(post.id)}
          className="flex min-h-[44px] items-center self-start text-[14px] font-bold text-heat-text underline-offset-2 hover:underline"
        >
          {`Continue thread · ${post.moreReplies} more ${post.moreReplies === 1 ? "reply" : "replies"}`}
        </a>
      ) : null}
    </article>
  );
}

/** The replies, in order, each indented 16 px a level (wave 4). */
export function PostTree({
  posts,
  actions,
}: {
  posts: PostView[];
  actions: PostActions;
}) {
  return (
    <ol
      aria-label="Comments"
      className="m-0 flex list-none flex-col gap-space-4 p-0"
    >
      {posts.map((post) => (
        <li key={post.id}>
          <PostItem post={post} actions={actions} />
        </li>
      ))}
    </ol>
  );
}

export type { PostActions };
