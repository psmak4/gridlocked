# M9 security review

M9 Task 9 (#296), 2026-11-23. A review against OWASP ASVS 5.0 level 1:
what was checked in each area, what was found, and what was done.

## New checks

| Check | Where |
| --- | --- |
| The access matrix: every exported server function (101 of them), called with no session and as a plain player | `src/server/authz-matrix.test.ts` |
| Every page's security headers and CSP, a nonce per page, and no CSP violation on load and hydration | `e2e/security-headers.spec.ts` |
| The CSP and the header set themselves | `src/lib/security-headers.test.ts` |

**The access matrix** stubs Start's runtime so each server function's handler
runs on its own, with empty input and no validator, so the function's own
guard is what answers. Every function that isn't on the matrix's public list
must refuse a call with no session as `unauthenticated`, and every staff
function must refuse a player as `forbidden`. Each public function is listed
with its reason (the forum, the hub and the price board are public to read,
the sign-up checks, a logged-out report behind Turnstile, the emailed
deletion link). A new server function fails the matrix until it refuses, or
is listed with a reason. A check that removed the staff guard from
`runStaff` failed both tests.

**A foreign Origin** is refused with a 403 before any server function runs,
by one request middleware (`serverFnCsrf` in `src/start.ts`). That is
already tested on its own (`src/server/csrf.test.ts`) and through the built
server (`e2e/csrf.spec.ts`), so the matrix doesn't repeat it per function.

## Findings

| # | Area | Finding | Done |
| --- | --- | --- | --- |
| 1 | Configuration (V3, V13) | No response carried a Content-Security-Policy, `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options` or HSTS. | **Fixed** in be577a0. Every response, pages and assets, gets `nosniff`, `strict-origin-when-cross-origin`, `DENY`, a Permissions-Policy and HSTS (two years, subdomains, no preload), through Nitro's route rules. Each page gets a CSP with a nonce of its own (`pageCsp` in `src/start.ts`); the router puts it on every script it writes, so no other inline script runs. Scripts come only from the app, the nonce and Turnstile; calls go only to the app, Turnstile and Sentry's ingest; framing, plugins, other `<base>`s and other form targets are refused. |
| 2 | Configuration | With the CSP on, Zod 4's probe for `new Function` was reported as a violation on every page (it is caught, so nothing broke). | **Fixed** in be577a0: a head script sets Zod's `jitless` before any module loads, so Zod parses without compiling. |
| 3 | Authentication (V6.2.4) | A new password is checked for length (10 to 128) but not against a list of common or breached passwords. | **Open, for the owner** (see below). |
| 4 | Dependencies (V15) | `pnpm audit` and Dependabot report two moderate advisories: esbuild ≤ 0.24.2 (its dev server answers any origin), through `better-auth > drizzle-kit`, and minimatch < 11.0.1 (a slow glob), a development dependency. | **Accepted.** Neither is in the built server: drizzle-kit and minimatch run only at development time, and the app never runs esbuild's dev server. Dependabot will offer the bumps. |
| 5 | Configuration (found through the CSP) | The e2e tests put axe on a page with a script tag, which the CSP rightly refuses. Running axe the new way showed a flaky failure: before React hydrates, a Checkbox or Switch has no name, because its label's `for` points at an id Base UI only sets once hydrated (WCAG 4.1.2). | **Fixed.** The e2e helper injects axe with `page.evaluate`, outside the page's policy, so the tests didn't loosen the CSP. Checkbox and Switch now name their control with `aria-labelledby` in the server's HTML, with a server-render test each. |

### Finding 3: the owner's choice

ASVS 5.0 6.2.4 (level 1) asks that a new password be checked against at
least the 3,000 most common passwords. There are two ways to do it:

- **Better Auth's `haveIBeenPwned` plugin.** It is in the package already.
  On sign-up, password change and reset, it sends the first five characters
  of the password's SHA-1 to `api.pwnedpasswords.com` (k-anonymity; the
  password never leaves) and refuses one that has been breached. It **fails
  closed**: if the service is down, nobody can sign up with a password or
  change one until it is back. The e2e runs would need it switched off.
- **A bundled list:** the 10,000 most common passwords (SecLists, MIT
  licence) checked in the sign-up and password hooks. No outside call, but a
  file to download into the repo, and it misses breached passwords that
  aren't common.

Until one is chosen, the 10-character minimum is the only check, which
already rules out most of the commonest passwords.

## What was checked and found sound

- **Authentication (V6).**
  - Passwords are 10 to 128 characters (ASVS asks for at least 8, and allows
    at least 64).
  - Sign-in, sign-up and password change are rate-limited by Better Auth's
    default rules. The magic link, reset request and verification email have
    tighter limits of their own, kept in the database because serverless
    memory doesn't last between requests.
  - A password reset ends every session.
  - Accounts link to Discord only when Discord says the email is verified;
    there is no `trustedProviders`, which would let an unverified Discord
    email take over an account.
  - Staff tools need TOTP once per session, and attempts are counted
    atomically before the code is checked.
- **Sessions (V7).**
  - The session cookie is `__Secure-`, HttpOnly and SameSite=Lax, and
    Better Auth checks it on the server on every request.
  - Signing in issues a new session.
  - Signing out, a ban and a password reset end sessions on the server.
  - Impersonation sessions are read-only and time-limited.
- **Access control (V8).**
  - The access matrix (above).
  - Object checks refuse another player's team (`team_not_owned`), and a
    private league's standings are shown only to its members and owner
    (tested in `src/play/standings.test.ts`).
  - Staff functions check the role before the input is parsed.
- **Input (V1, V2).**
  - Every server function has a Zod validator, and the staff ones are strict
    objects.
  - The test routes under `/api/test/*` return 404 unless the build has
    `VITE_LOCAL_DB=1`, and CI builds the deployed way and fails if their
    code got in.
- **Output encoding (V1).**
  - Posts are Markdown through micromark, which escapes raw HTML.
  - Links survive only as `http(s)` and only for authors allowed to post
    links (or embed hosts), with `rel="nofollow ugc noopener noreferrer"`.
  - Images become their alt text.
  - React escapes everything else.
  - The CSP is now a second line behind all of this.
- **CSRF (V3.5).** `serverFnCsrf` refuses cross-site server-function calls,
  and GET server functions change nothing a person would notice. The one
  write a GET makes is recording a visit.
- **Files (V5).**
  - Nothing is uploaded.
  - The data export is written to object storage and handed out as a
    presigned GET that expires.
  - The deletion link's token is 32 random bytes, kept only as its SHA-256
    hash, and good for one hour. The referrer policy keeps it out of any
    cross-site request.
- **Errors and logging (V16).**
  - An unexpected error leaves a server function as `server_error` with no
    address or link in it, and is logged by class name only.
  - Error responses are `private, no-store`.
  - The audit log carries ids and codes, not personal data.
- **Data protection (V14).**
  - Every answer about the viewer is `private, no-store`, and public pages
    are cached only for logged-out readers (M9 Task 6).
  - The client build has no source maps.
- **Cryptography (V11).** Tokens and the CSP nonce come from the platform's
  CSPRNG (`randomBytes`, `crypto.getRandomValues`).

## Notes

- A public page's HTML is cached at the edge for up to 90 seconds with its
  nonce, so logged-out readers in that window share one. The page is the
  same for all of them, and anything a person can put on a page is escaped
  (above), so a shared nonce gives an attacker nothing to inject with.
- The headers reach Vercel through Nitro's route rules and the CSP through
  the function's response. Task 12 checks both on staging.
- Out of scope at level 1, and left as they are:
  - sign-up says when an email is already in use (account enumeration, ASVS
    6.3.8 is level 3);
  - session lifetime is Better Auth's default (7 days, renewed daily).
