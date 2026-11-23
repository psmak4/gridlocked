# The site's storage keys

The scheduler tick sleeps on one small file, `scheduler/due-times.json`, in the branch's Neon Object Storage. It opens the database only when that file says a job is due. The tick function gets its storage keys from Neon. The website doesn't, so on its own it can't move the file earlier. Without keys, a staff action that brings a job forward waits for the 6-hourly safety tick:

- a lock moved earlier;
- a session time changed;
- a dry run started (M9 Task 7).

With keys, the site rewrites the file and the tick picks the job up within a minute. The code already reads them (`src/server/due-store.ts`); only the environment needs them.

You do this yourself. Claude never creates, sees or enters these values.

## Once per environment

1. **Issue a credential on the site's branch.** Use the branch the site's `DATABASE_URL` points at (staging's main branch for staging, `beta` for the beta site, production's for production). In the Neon Console, open the project, go to **Settings → Credentials → Create credential**, name it `site-due-times`, and tick `storage:read` and `storage:write`. Or use the CLI:

   ```bash
   neon credentials create --name site-due-times --scope storage:read --scope storage:write --project-id <project-id> --branch <branch>
   ```

   Copy the secret as soon as it's shown; Neon shows it once.

2. **Find the endpoint and region.** Open **Connect → Storage → Parameters only** on the same branch. It shows `AWS_ENDPOINT_URL_S3` and `AWS_REGION`.

3. **Add four variables to the Vercel project**, in the environment the site deploys to (staging deploys with `--prod`, so that's **Production**). Mark the secret one *Sensitive*:

   | Variable | Value |
   | - | - |
   | `AWS_ENDPOINT_URL_S3` | the branch's storage endpoint |
   | `AWS_REGION` | the region, such as `us-east-2` |
   | `AWS_ACCESS_KEY_ID` | the credential's `token_id` (`nak_live_…`) |
   | `AWS_SECRET_ACCESS_KEY` | the credential's `s3_secret_access_key` (`nsk_live_…`) |

4. **Redeploy the site.** Vercel reads new variables on the next deploy.

## Checking it

Move a lock earlier on the Calendar screen. The function's log should show the tick waking within a minute or two, not at the next safety tick. Without the keys, the site's log says `due-times store: no AWS_* variables, so none`.

## What the credential can reach

The credential works on its branch and on any branch made from it. It covers every bucket there: `scheduler`, `exports` and `chat-archives`. The site already holds `DATABASE_URL`, which reaches more than this. To retire it, revoke it under **Settings → Credentials** (or `neon credentials revoke <token_id>`), then remove the four variables.
