# Backups and the restore drill

Every night at 04:00 UTC, `.github/workflows/backup.yml` backs up the staging database:

1. **Dump.** `pnpm backup-dump` opens one read-only snapshot, then:
   - runs `pg_dump --format=custom` in it;
   - counts every table's rows in the same snapshot.
2. **Check.** `pnpm backup-check dump` renders the dump back to SQL with `pg_restore` and requires the closing line, `-- PostgreSQL database dump complete`. A cut-short dump has no such line. The dump must also be at least 32 KB.
3. **Encrypt.** `age` encrypts the dump to your public key. The result must be an age file, and no smaller than the dump.
4. **Store.** The workflow uploads `backups/staging/<date>.dump.age` and `<date>.counts.tsv` to the branch's Neon Object Storage. It deletes any copy past the newest 14.

Any failed check fails the run, and nothing from it is kept. The counts file holds table names and row counts, nothing else. The private key never goes to GitHub, Neon or Claude: only you can decrypt a backup.

You do the setup and hold the key. Claude never creates, sees or enters these values.

## Setup, once

1. **Make the key pair on your own machine.** Install age (`brew install age`), then:

   ```bash
   age-keygen -o paddock-backups.key
   ```

   It prints the public key, `age1…`. Keep `paddock-backups.key` in your password manager, plus one offline copy. **Without it, no backup can ever be read.**

2. **Issue a storage credential for the backups.** It's like the site's, but kept separate so either can be revoked alone. In the Neon Console, open `gridlocked-staging`, go to the `main` branch, then **Settings → Credentials → Create credential**. Name it `backups` and tick `storage:read` and `storage:write`. Copy the secret straight away: Neon shows it once. **Connect → Storage → Parameters only** shows the endpoint and region.

3. **Add these to the GitHub `staging` environment** (**Settings → Environments → staging**):

   | Name | Kind | Value |
   | - | - | - |
   | `BACKUP_AGE_RECIPIENT` | variable | the public key, `age1…` |
   | `BACKUP_AWS_ENDPOINT_URL_S3` | variable | the storage endpoint |
   | `BACKUP_AWS_REGION` | variable | the region, such as `aws-us-east-1` |
   | `BACKUP_AWS_ACCESS_KEY_ID` | **secret** | the credential's key id |
   | `BACKUP_AWS_SECRET_ACCESS_KEY` | **secret** | the credential's secret |

   `DATABASE_URL_STAGING` is already there.

4. **Deploy staging once.** `neon deploy` creates the `backups` bucket from `neon.ts`. Then run **Actions → Backup (staging) → Run workflow** and check that it's green.

Until the settings are in, the nightly run fails and its first step names the missing ones.

## The restore drill

Do this once after setup, then again whenever the dump or the schema changes a lot. It needs about 15 minutes, the Neon CLI (`npm i -g neon`, signed in with `neon auth`), the AWS CLI (`brew install awscli`) and `pg_restore` 17 (`brew install postgresql@17`).

1. **Fetch the latest backup and its counts.** Run these in a shell that has the backup credential's four values exported as `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3` and `AWS_REGION`:

   ```bash
   aws configure set default.s3.addressing_style path
   aws s3 ls s3://backups/staging/
   aws s3 cp s3://backups/staging/<date>.dump.age .
   aws s3 cp s3://backups/staging/<date>.counts.tsv .
   ```

2. **Decrypt it on your machine.**

   ```bash
   age --decrypt --identity paddock-backups.key --output restore.dump <date>.dump.age
   pnpm backup-check dump restore.dump
   ```

   `restore.dump` is the whole database in plain form: real accounts and email addresses. Keep it on your machine only, and delete it at the end (step 6).

3. **Make an empty database to restore into.** A new Neon branch is a copy of its parent, so restore into a new database on it:

   ```bash
   neon branches create --project-id ancient-fog-03461181 --name restore-drill
   neon databases create --project-id ancient-fog-03461181 --branch restore-drill --name restored
   neon connection-string restore-drill --project-id ancient-fog-03461181 --database-name restored > drill-url.txt
   ```

4. **Restore.**

   ```bash
   pg_restore --no-owner --no-privileges --exit-on-error --dbname "$(cat drill-url.txt)" restore.dump
   ```

5. **Count, and compare.**

   ```bash
   DATABASE_URL="$(cat drill-url.txt)" pnpm backup-dump --counts-only restored.counts.tsv
   pnpm backup-check diff <date>.counts.tsv restored.counts.tsv
   ```

   `backup-check: diff ok` means every table has the row count it had at the dump. Any other line names a table that differs: the drill failed. Keep the branch, and look at that table before deleting anything.

6. **Clean up.**

   ```bash
   neon branches delete restore-drill --project-id ancient-fog-03461181
   rm restore.dump drill-url.txt <date>.dump.age
   ```

   Write the date and the result in the ledger, or tell Claude.

## Restoring for real

Follow the drill as far as step 5, restoring into a new branch rather than over the live one. Then point the site at that branch's connection string:

- `DATABASE_URL` in Vercel;
- `DATABASE_URL_STAGING` in GitHub.

Deploy, and keep the old branch until the site is checked. A restore loses everything written after the dump's night. Rows the provider pipeline wrote come back on the next poll; posts and lineups don't.
