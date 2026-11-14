import { createFileRoute } from "@tanstack/react-router";
import { Body, Screen } from "@/components/account-layout";
import { Badge } from "@/components/ui/badge";
import { privateHeaders } from "@/lib/private-headers";
import { settingsGuard } from "@/lib/settings-guard";
import { getProfile } from "@/server/account";

export const Route = createFileRoute("/profile")({
  beforeLoad: ({ context }) => settingsGuard({ account: context.account }),
  head: () => ({ meta: [{ title: "Profile · Gridlocked" }] }),
  headers: privateHeaders,
  loader: () => getProfile(),
  component: Profile,
});

/** Two letters for the avatar: the first of each word, or the first two. */
function initials(username: string): string {
  const words = username.split(/[_.]+/).filter(Boolean);
  const letters =
    words.length > 1 ? words[0]![0]! + words[1]![0]! : username.slice(0, 2);
  return letters.toUpperCase();
}

/**
 * The profile (wave 4): the username, the trust level in plain words,
 * favorites, the join date and the teams (M6). Recent posts join in M7.
 */
function Profile() {
  const profile = Route.useLoaderData();
  const { team, driver, country } = profile.favorites;
  const fan = [driver ? `${driver} fan` : null, country].filter(Boolean);
  return (
    <Screen>
      <header className="flex shrink-0 items-center justify-between px-space-4 pt-[10px] pb-space-2">
        <a
          href="/"
          className="font-display text-[24px] leading-[28px] text-ink no-underline"
        >
          GRIDLOCKED
        </a>
        <a
          href="/settings"
          aria-label="Settings"
          className="flex size-[44px] items-center justify-center rounded-radius-m text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        >
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" />
          </svg>
        </a>
      </header>
      <Body className="pt-0">
        <div className="flex items-center gap-[14px]">
          <span
            aria-hidden="true"
            className="flex size-[72px] shrink-0 items-center justify-center rounded-full border-[3px] border-line-strong bg-surface-raised font-display text-[28px]"
            style={team ? { borderColor: team.color } : undefined}
          >
            {initials(profile.username)}
          </span>
          <div className="flex min-w-0 flex-col gap-[4px]">
            <h1 className="font-display text-[28px] leading-[30px] font-normal break-all uppercase">
              {profile.username}
            </h1>
            <div className="flex flex-wrap items-center gap-[6px]">
              <Badge tone="neutral">{profile.trust.name}</Badge>
              {team ? (
                <span className="inline-flex items-center gap-[5px] text-[14px] font-semibold">
                  <span
                    aria-hidden="true"
                    className="h-[6px] w-[18px] rounded-radius-pill"
                    style={{ backgroundColor: team.color }}
                  />
                  {team.name}
                </span>
              ) : null}
              {fan.length > 0 ? (
                <span className="text-[14px] text-ink-muted">
                  {fan.join(" · ")}
                </span>
              ) : null}
            </div>
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-space-2">
          {[
            { label: "REPUTATION", value: String(profile.reputation) },
            { label: "JOINED", value: profile.joined },
          ].map((stat) => (
            <div
              key={stat.label}
              className="flex flex-col gap-[2px] rounded-radius-m bg-surface-raised px-space-3 py-[10px]"
            >
              <dt className="text-[12px] font-bold tracking-[0.12em] text-ink-muted">
                {stat.label}
              </dt>
              <dd className="font-numeric text-[18px] font-bold">
                {stat.value}
              </dd>
            </div>
          ))}
        </dl>
        <p className="text-[14px] leading-[20px] text-ink-muted">
          {profile.trust.allows}
        </p>
        {team || driver || country ? null : (
          <p className="text-[14px] leading-[20px] text-ink-muted">
            No favorites yet.{" "}
            <a
              href="/settings/favorites"
              className="font-bold text-heat-text underline-offset-2 hover:underline"
            >
              Choose them in settings
            </a>
            .
          </p>
        )}

        <section
          aria-labelledby="profile-teams"
          className="flex flex-col gap-space-2"
        >
          <h2
            id="profile-teams"
            className="m-0 text-[12px] font-bold tracking-[0.12em] text-ink-muted"
          >
            TEAMS
          </h2>
          {profile.teams.length > 0 ? (
            <ul className="m-0 flex list-none flex-col gap-space-2 p-0">
              {profile.teams.map((t) => (
                <li key={t.slot}>
                  {t.status === "active" ? (
                    <a
                      href={`/team/${t.slot}`}
                      className="flex min-h-[44px] items-center justify-between gap-space-3 rounded-radius-m bg-surface-raised px-space-3 py-space-2 text-ink no-underline outline-none hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                    >
                      <span className="min-w-0 font-bold break-words">
                        {t.name}
                      </span>
                      <span className="shrink-0 text-[14px] text-ink-muted">
                        Team {t.slot}
                      </span>
                    </a>
                  ) : (
                    <span className="flex min-h-[44px] items-center justify-between gap-space-3 rounded-radius-m bg-surface-raised px-space-3 py-space-2 text-ink-muted">
                      <span className="min-w-0 font-bold break-words">
                        {t.name}
                      </span>
                      <span className="flex shrink-0 items-center gap-space-2 text-[14px]">
                        Team {t.slot}
                        <Badge tone="neutral">Retired</Badge>
                      </span>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[14px] leading-[20px] text-ink-muted">
              No team yet.{" "}
              <a
                href="/team"
                className="font-bold text-heat-text underline-offset-2 hover:underline"
              >
                Create a team
              </a>
              .
            </p>
          )}
        </section>
      </Body>
    </Screen>
  );
}
