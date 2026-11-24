# Sentry

Errors reach Sentry with values removed. Three places report:

- the browser;
- the server functions;
- the scheduler tick.

`scrub` in `src/lib/report-error.ts` builds each event from an allowlist. It keeps:

- the error's class, and its causes';
- the stack frames, with query strings removed;
- a constant code, such as `PASSWORD_TOO_COMMON`;
- the route's pattern, such as `/u/$username`, or the server function's file and name;
- the release and environment;
- the browser or runtime's name and version.

Everything else stays behind: messages, request data, the user, cookies, headers, breadcrumbs' data and messages, and extra. The browser's SDK is also set to collect none of it, and the server and tick send only what `scrub` built.

With no DSN, nothing reports and the browser never loads the SDK. That covers local runs, tests, CI, and any deploy whose environment has no `SENTRY_DSN` variable.

You do this yourself. Claude never creates, sees or enters these values.

## Once

1. **Create the project.** Sign in at sentry.io on the free Developer plan, with no card. Create a project with the platform **TanStack Start (React)** and name it `paddock-club`. Turn off alert rules you don't want; the default emails you on a new issue.
2. **Copy the DSN.** It's under **Project Settings → Client Keys (DSN)**. A DSN isn't secret: it's in every page the browser loads. It can only send events to the project.
3. **Create an auth token for source maps.** Go to **Settings → Developer Settings → Organization Tokens → Create New Token**, name it `paddock-club-deploy`, and copy it. Sentry shows it once. An organization token can upload source maps and create releases, and nothing else.
4. **Add these to the GitHub `staging` environment:** go to the repository's **Settings → Environments → staging**.

   | Name | Kind | Value |
   | - | - | - |
   | `SENTRY_DSN` | variable | the DSN |
   | `SENTRY_ORG` | variable | your organization's slug (in the URL: `sentry.io/organizations/<slug>/`) |
   | `SENTRY_PROJECT` | variable | `paddock-club` |
   | `SENTRY_AUTH_TOKEN` | **secret** | the auth token |

   The token goes in as a secret, never a variable: a variable prints in plain text.

Vercel needs nothing: the deploy builds the DSN into the site's code.

## What the deploy does with them

`.github/workflows/deploy-staging.yml`:

- **Builds the site** with `VITE_SENTRY_DSN`, `VITE_SENTRY_RELEASE` (the commit) and `VITE_SENTRY_ENVIRONMENT=staging`. The browser and the Vercel server read them from the build.
- **Uploads the source maps.** With `SENTRY_AUTH_TOKEN`, the build turns source maps on, uploads them under the release, and deletes them. A later check fails the deploy if any `.map` file is left in what's served.
  - If the upload fails, the build still finishes, and the deploy log says why.
- **Gives the tick `SENTRY_DSN`, `SENTRY_RELEASE` and `SENTRY_ENVIRONMENT`** through `neon deploy` (`neon.ts`).

## Checking it after a deploy

1. **Wait for the first real error.** A refusal (signed out, not allowed, not found) isn't one: only an error the code didn't expect is reported. An error thrown from the browser's developer console doesn't count either: Sentry ignores those.
2. In Sentry, open **Issues**. The event should show:
   - the class, the route pattern and the release;
   - no message, no address, no username and no request body.
3. If it shows a value it shouldn't, that's a bug in `scrub`. Delete the event in Sentry, and fix `scrub` with a test that fails first.

## For production (Task 15)

Use the same project with `SENTRY_ENVIRONMENT=production`, or make a second project. Add the same four names to the production environment.
