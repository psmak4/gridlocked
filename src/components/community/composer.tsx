import { useId, useState, type ComponentProps } from "react";
import type { ComposerData } from "@/community/composer";
import type { CommunityRefusal } from "@/community/errors";
import { POST_BODY_MAX, THREAD_TITLE_MAX } from "@/community/limits";
import { looksLikeSpoilerTitle } from "@/community/text";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { TextField } from "@/components/ui/text-field";
import { cn } from "@/lib/utils";
import { FAILED, refusalWords } from "./forum-words";

const fieldLabel = "text-[14px] font-bold text-ink";
const control =
  "rounded-radius-m border-2 border-line-strong bg-surface px-space-3 font-sans text-[16px] text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:cursor-not-allowed disabled:opacity-45 aria-invalid:border-fall";

/** A post's text: Markdown, up to 10,000 characters. */
function TextArea({
  id,
  label,
  className,
  ...props
}: Omit<ComponentProps<"textarea">, "id"> & { id: string; label: string }) {
  return (
    <div className="flex flex-col gap-[6px] font-sans">
      <label htmlFor={id} className={fieldLabel}>
        {label}
      </label>
      <textarea
        id={id}
        maxLength={POST_BODY_MAX}
        className={cn(
          control,
          "min-h-[120px] py-space-2 leading-[22px]",
          className,
        )}
        {...props}
      />
    </div>
  );
}

/** What a write gives back: done, or why not. */
type WriteResult = { ok: true } | CommunityRefusal;

/** Runs a write and turns its refusal or failure into words. */
async function attempt(
  write: () => Promise<WriteResult>,
): Promise<string | null> {
  try {
    const result = await write();
    return result.ok ? null : refusalWords(result);
  } catch {
    return FAILED;
  }
}

/** "Reply" at the top of a thread or under a post. */
export function ReplyForm({
  label = "Reply",
  submitLabel = "Post reply",
  initial = "",
  onSubmit,
  onCancel,
}: {
  label?: string;
  submitLabel?: string;
  /** The text the box starts with: a post's own, for "Edit". */
  initial?: string;
  onSubmit: (body: string) => Promise<WriteResult>;
  onCancel?: () => void;
}) {
  const id = useId();
  const [body, setBody] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="flex flex-col gap-space-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!body.trim()) return;
        setBusy(true);
        void attempt(() => onSubmit(body)).then((message) => {
          setBusy(false);
          setError(message);
          if (!message) setBody("");
        });
      }}
    >
      <TextArea
        id={id}
        label={label}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        required
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
      />
      {error ? (
        <p
          id={`${id}-error`}
          role="alert"
          className="m-0 text-[14px] font-semibold text-fall"
        >
          {error}
        </p>
      ) : null}
      <div className="flex gap-space-2">
        <Button type="submit" disabled={busy || !body.trim()}>
          {submitLabel}
        </Button>
        {onCancel ? (
          <Button type="button" variant="quiet" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}

export type NewThread = {
  categoryId: string;
  title: string;
  body: string;
  sessionId?: string;
  containsSpoilers?: boolean;
};

/**
 * "New thread" (wave 4): category, title and post. In Race Weekend a title
 * that looks like a result brings up the warning, with "Contains spoilers"
 * ticked; leaving it ticked hides the thread from anyone who hasn't watched.
 */
export function NewThreadForm({
  data,
  initialCategory,
  onSubmit,
}: {
  data: ComposerData;
  initialCategory?: string;
  onSubmit: (thread: NewThread) => Promise<WriteResult>;
}) {
  const ids = {
    category: useId(),
    title: useId(),
    body: useId(),
    spoiler: useId(),
  };
  const start =
    data.categories.find((c) => c.slug === initialCategory) ??
    data.categories[0];
  const [categoryId, setCategoryId] = useState(start?.id ?? "");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [spoilers, setSpoilers] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const category = data.categories.find((c) => c.id === categoryId);
  const session = data.spoilerSession;
  const warn =
    category?.kind === "race_weekend" &&
    session !== null &&
    looksLikeSpoilerTitle(title, data.spoilerNames);

  return (
    <form
      className="flex flex-col gap-space-4"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        void attempt(() =>
          onSubmit({
            categoryId,
            title,
            body,
            // Shown the warning, the person's answer is what counts; otherwise
            // the server's own title check decides.
            ...(warn && session
              ? spoilers
                ? { containsSpoilers: true, sessionId: session.id }
                : { containsSpoilers: false }
              : {}),
          }),
        ).then((message) => {
          setBusy(false);
          setError(message);
        });
      }}
    >
      <div className="flex flex-col gap-[6px] font-sans">
        <label htmlFor={ids.category} className={fieldLabel}>
          Category
        </label>
        <select
          id={ids.category}
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
          className={cn(control, "min-h-[48px]")}
        >
          {data.categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      <TextField
        id={ids.title}
        label="Title"
        value={title}
        maxLength={THREAD_TITLE_MAX}
        required
        onChange={(e) => setTitle(e.target.value)}
      />

      {warn && session ? (
        <div
          role="status"
          className="flex flex-col gap-space-2 rounded-radius-m border-2 border-caution p-space-3"
        >
          <p className="m-0 text-[16px] leading-[22px] font-bold">
            This title may give away a result from this weekend.
          </p>
          <p className="m-0 text-[14px] leading-[20px] text-ink-muted">
            {
              "Mark it as a spoiler and people who haven't watched will see “Spoiler thread” instead."
            }
          </p>
          <Checkbox
            id={ids.spoiler}
            label={`Contains spoilers for ${session.phrase}`}
            checked={spoilers}
            onCheckedChange={(checked) => setSpoilers(checked === true)}
          />
        </div>
      ) : null}

      <div className="flex flex-col gap-[6px]">
        <TextArea
          id={ids.body}
          label="Post"
          value={body}
          required
          onChange={(e) => setBody(e.target.value)}
          aria-describedby={`${ids.body}-help`}
        />
        <p id={`${ids.body}-help`} className="m-0 text-[14px] text-ink-muted">
          You can add links. YouTube, Imgur and X links show as previews.
        </p>
      </div>

      {error ? (
        <p role="alert" className="m-0 text-[14px] font-semibold text-fall">
          {error}
        </p>
      ) : null}

      <div className="flex flex-col gap-space-2">
        <Button
          type="submit"
          size="l"
          block
          disabled={busy || !categoryId || !title.trim() || !body.trim()}
        >
          Post thread
        </Button>
        <p className="m-0 text-center text-[14px] text-ink-muted">
          Be decent.{" "}
          <a href="/legal/community_rules" className="font-bold text-ink">
            Community rules
          </a>
        </p>
      </div>
    </form>
  );
}
