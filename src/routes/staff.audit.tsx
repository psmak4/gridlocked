import { createFileRoute } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { AUDIT_GROUPS, type AuditGroup } from "@/audit/actions";
import { privateHeaders } from "@/lib/private-headers";
import { getAuditLog, type AuditInput } from "@/server/staff";
import { STAFF_ERROR_WORDS } from "@/staff/errors";

/** The filters, from the address, so a filtered page can be linked. */
function auditSearch(search: Record<string, unknown>): AuditInput {
  const text = (key: string) =>
    typeof search[key] === "string" && search[key] !== ""
      ? (search[key] as string)
      : undefined;
  return {
    who: text("who"),
    group: text("group") as AuditGroup | undefined,
    before: text("before"),
  };
}

/**
 * The audit log (wave 5, M8 Task 4): every staff change and security event,
 * newest first, 50 a page, filtered by who and by what. Read-only.
 */
export const Route = createFileRoute("/staff/audit")({
  validateSearch: auditSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) => getAuditLog({ data: deps }),
  head: () => ({ meta: [{ title: "Audit log · Staff · Gridlocked" }] }),
  headers: privateHeaders,
  component: AuditLog,
});

const selectClass =
  "min-h-[48px] rounded-radius-m border-2 border-line-strong bg-surface px-space-3 font-sans text-[16px] text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring";

const COLUMNS = ["When", "Who", "What", "On", "Change", "Reason"] as const;

function AuditLog() {
  const result = Route.useLoaderData();
  const search = Route.useSearch();
  if (!result.ok) {
    return (
      <>
        <h1 className="font-display text-[32px] leading-[36px] uppercase">
          Audit log
        </h1>
        <p role="alert" className="text-[16px] font-semibold text-fall">
          {STAFF_ERROR_WORDS[result.error]}
        </p>
      </>
    );
  }
  const { rows, next, actors } = result.value;
  const older = new URLSearchParams(
    Object.entries({ ...search, before: next ?? "" }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  return (
    <>
      <header className="flex flex-col gap-space-2">
        <h1 className="font-display text-[32px] leading-[36px] uppercase">
          Audit log
        </h1>
        <p className="text-[16px] text-ink-muted">
          Every staff change and security event. Nothing here can be edited or
          deleted. Emails and IP addresses are never stored.
        </p>
      </header>

      <form
        method="get"
        action="/staff/audit"
        className="flex flex-col gap-space-3 sm:flex-row sm:items-end"
      >
        <label className="flex flex-col gap-[6px] text-[14px] font-bold">
          Who
          <select
            name="who"
            defaultValue={search.who ?? ""}
            className={selectClass}
          >
            <option value="">Everyone</option>
            {actors.map((a) => (
              <option key={a.userId} value={a.userId}>
                {a.username}
              </option>
            ))}
            <option value="jobs">Jobs</option>
          </select>
        </label>
        <label className="flex flex-col gap-[6px] text-[14px] font-bold">
          What
          <select
            name="group"
            defaultValue={search.group ?? ""}
            className={selectClass}
          >
            <option value="">Everything</option>
            {(Object.keys(AUDIT_GROUPS) as AuditGroup[]).map((g) => (
              <option key={g} value={g}>
                {AUDIT_GROUPS[g]}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="secondary">
          Show
        </Button>
      </form>

      {rows.length === 0 ? (
        <p className="text-[16px] text-ink-muted">Nothing recorded yet.</p>
      ) : (
        <table className="w-full border-collapse text-left text-[16px]">
          <thead className="max-lg:sr-only">
            <tr className="border-b-2 border-line-strong">
              {COLUMNS.map((c) => (
                <th
                  key={c}
                  scope="col"
                  className="px-space-2 py-space-2 text-[14px] font-bold text-ink-muted"
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.id}
                className="border-b border-line align-top max-lg:flex max-lg:flex-col max-lg:py-space-2"
              >
                {(
                  [
                    ["When", row.whenLabel],
                    ["Who", row.who],
                    ["What", row.what],
                    ["On", row.on],
                    ["Change", row.change],
                    ["Reason", row.reason ?? "—"],
                  ] as const
                ).map(([label, value]) => (
                  <td
                    key={label}
                    data-label={label}
                    className="px-space-2 py-space-1 max-lg:before:block max-lg:before:text-[14px] max-lg:before:font-bold max-lg:before:text-ink-muted max-lg:before:content-[attr(data-label)] lg:py-space-2"
                  >
                    {Array.isArray(value) ? (
                      value.length === 0 ? (
                        "—"
                      ) : (
                        <ul className="m-0 list-none p-0">
                          {value.map((line) => (
                            <li key={line} className="font-numeric">
                              {line}
                            </li>
                          ))}
                        </ul>
                      )
                    ) : (
                      value
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {next ? (
        <a
          href={`/staff/audit?${older.toString()}`}
          className="flex min-h-[44px] items-center self-start font-bold text-heat-text underline-offset-2 hover:underline"
        >
          Older
        </a>
      ) : null}
    </>
  );
}
