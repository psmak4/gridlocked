import { useState } from "react";
import {
  createFileRoute,
  Link,
  Outlet,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { trustWords } from "@/lib/settings-words";
import { privateHeaders } from "@/lib/private-headers";
import { cn } from "@/lib/utils";
import { getUsers } from "@/server/staff";
import { STAFF_ERROR_WORDS } from "@/staff/errors";

/**
 * Users (wave 5's users board, M8 Task 12): a search by username, never by
 * address, and the matches; picking one opens their panel beside the list
 * (`/staff/users/$username`). On a narrow screen the panel comes first.
 */
export const Route = createFileRoute("/staff/users")({
  validateSearch: (search: Record<string, unknown>): { q: string } => ({
    q: typeof search.q === "string" ? search.q.slice(0, 64) : "",
  }),
  loaderDeps: ({ search }) => ({ q: search.q }),
  loader: ({ deps }) => getUsers({ data: { query: deps.q } }),
  head: () => ({ meta: [{ title: "Users · Staff · Gridlocked" }] }),
  headers: privateHeaders,
  component: UsersScreen,
});

const eyebrow = "text-[12px] font-bold tracking-[0.12em] text-ink-muted";
const inputClass =
  "min-h-[48px] w-full rounded-radius-m border-2 border-line-strong bg-surface px-space-3 font-sans text-[16px] text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring";

export const ROLE_WORDS: Record<string, string> = {
  user: "User",
  moderator: "Moderator",
  admin: "Admin",
};

function UsersScreen() {
  const result = Route.useLoaderData();
  const { q } = Route.useSearch();
  const navigate = useNavigate();
  const [query, setQuery] = useState(q);
  const { pathname } = useLocation();
  const selected = decodeURIComponent(pathname.split("/")[3] ?? "");

  return (
    <>
      <header className="flex flex-col gap-space-1">
        <span className={eyebrow}>MODERATION</span>
        <h1 className="font-display text-[36px] leading-[38px] font-normal uppercase">
          Users
        </h1>
        <p className="max-w-[760px] text-[16px] text-ink-muted">
          Find someone by username. Every change takes a reason for the audit
          log.
        </p>
      </header>

      <form
        role="search"
        aria-label="Find a user"
        className="flex max-w-[560px] flex-wrap items-end gap-space-3"
        onSubmit={(e) => {
          e.preventDefault();
          void navigate({ to: "/staff/users", search: { q: query.trim() } });
        }}
      >
        <label className="flex min-w-0 flex-[1_1_240px] flex-col gap-[6px] text-[14px] font-bold">
          Username starts with
          <input
            type="search"
            value={query}
            maxLength={64}
            autoComplete="off"
            onChange={(e) => setQuery(e.target.value)}
            className={inputClass}
          />
        </label>
        <Button type="submit">Find</Button>
      </form>

      <div className="flex flex-wrap items-start gap-space-5">
        <div className="min-w-0 flex-[3_1_480px] max-lg:order-last">
          {!result.ok ? (
            <p role="alert" className="text-[16px] font-semibold text-fall">
              {STAFF_ERROR_WORDS[result.error]}
            </p>
          ) : !q ? (
            <p className="rounded-radius-l bg-surface-raised p-space-4 text-[16px] text-ink-muted">
              Type the start of a username. Addresses aren&apos;t searched.
            </p>
          ) : result.value.length === 0 ? (
            <p className="rounded-radius-l bg-surface-raised p-space-4 text-[16px] text-ink-muted">
              Nobody&apos;s username starts with “{q}”.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-[16px]">
                <caption className="sr-only">Users</caption>
                <thead>
                  <tr className={eyebrow}>
                    <th className="py-space-2 pr-space-3 font-bold">
                      USERNAME
                    </th>
                    <th className="py-space-2 pr-space-3 font-bold">ROLE</th>
                    <th className="py-space-2 pr-space-3 font-bold">TRUST</th>
                    <th className="py-space-2 font-bold">JOINED</th>
                  </tr>
                </thead>
                <tbody>
                  {result.value.map((u) => (
                    <tr
                      key={u.userId}
                      data-slot="user-row"
                      className={cn(
                        "border-t border-line",
                        u.username.toLowerCase() === selected.toLowerCase() &&
                          "bg-surface-raised",
                      )}
                    >
                      <td className="py-space-2 pr-space-3">
                        <Link
                          to="/staff/users/$username"
                          params={{ username: u.username }}
                          search={{ q }}
                          className="flex min-h-[44px] items-center gap-space-2 font-bold text-ink underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                        >
                          {u.username}
                          {u.banned ? (
                            <Badge tone="caution">Banned</Badge>
                          ) : null}
                        </Link>
                      </td>
                      <td className="py-space-2 pr-space-3">
                        {ROLE_WORDS[u.role] ?? u.role}
                      </td>
                      <td className="py-space-2 pr-space-3">
                        {trustWords(u.trustLevel).name}
                      </td>
                      <td className="py-space-2">{u.joined}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <Outlet />
      </div>
    </>
  );
}
