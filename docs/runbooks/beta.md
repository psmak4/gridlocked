# The closed beta

The beta replays the 2026 season from round 1 on a `beta` branch of the Neon project `gridlocked-staging`. The site, `gridlocked-staging`, points at that branch for the beta's weeks, and back at `main` afterwards. The replay's clock is real time minus a whole number of days, so a 2026 weekend plays out over a real one, at the same times of day (UTC).

Results aren't loaded in advance. The pipeline polls Jolpica and OpenF1 for each session after it ends on the replay's clock, as in a live season.

Claude never creates, sees or enters the values below. Each step that writes to Neon or deploys needs your OK.

## What switches it on

One variable in the GitHub `staging` environment, `BETA_RUNNING`:

| `BETA_RUNNING` | The site | Nightly backup | Daily usage snapshot |
| - | - | - | - |
| not `true` | deployed with `target: main` | `main` | written to `main` |
| `true` | deployed with `target: beta` | `main` and `beta` | written to `beta` |

While it's `true`, a deploy with `target: main` still migrates `main` and deploys its tick, but leaves the site alone. Without it, a deploy with `target: beta` is refused. A missing `DATABASE_URL_BETA` fails a run. It never falls back to `main`.

## Setting it up, once

1. **Create the branch, with the schema and none of the data.** A normal branch would copy staging's accounts.

   ```bash
   neon branches create --project-id ancient-fog-03461181 --name beta --parent main --schema-only
   ```

   In the Console, choose **Schema only** and **untick "Automatically delete branch after"**: it's on by default, at 1 day. The Free plan allows 3 root branches, and this is one.

2. **Empty it.** A schema-only branch has the tables but not the list of migrations that made them, so the migrations would fail on the first table. In the Neon SQL Editor, select the **`beta`** branch, and run this. It stops without changing anything if the database has any account, which `main` does:

   ```sql
   BEGIN;
   DO $$ BEGIN
     IF EXISTS (SELECT 1 FROM public.users) THEN
       RAISE EXCEPTION 'this database has accounts: is it the beta branch?';
     END IF;
   END $$;
   DROP SCHEMA public CASCADE;
   DROP SCHEMA IF EXISTS drizzle CASCADE;
   CREATE SCHEMA public;
   COMMIT;
   ```

3. **Add two names to the GitHub `staging` environment:**

   | Name | Kind | Value |
   | - | - | - |
   | `DATABASE_URL_BETA` | **secret** | the `beta` branch's **direct** (unpooled) connection string |
   | `BETA_RUNNING` | variable | `true` |

   The backup, storage and Sentry names stay as they are. The beta's backups go to `main`'s bucket, under `backups/beta/`, so they outlive the branch.

4. **Point the site at the beta.** In the Vercel project (**Settings → Environment Variables**, Production):

   | Name | For the beta |
   | - | - |
   | `DATABASE_URL` | the `beta` branch's **pooled** connection string |
   | `CLOCK_MODE` | `replay` |
   | `SIGN_UP_ALLOWED_EMAILS` | the invite list (below) |
   | the four `AWS_*` names | a credential issued on the `beta` branch ([site-storage-keys.md](site-storage-keys.md)) |

   They take effect on the next deploy. The site refuses to answer if `CLOCK_MODE` and the database disagree, so a half-made change shows as errors, not as wrong dates. The storage keys matter more here than on `main`: without them, the tick learns of a jump only at its next wake.

5. **Deploy, seeding the game.** Choose the first beta Friday. Round 1's Friday lands on it, so testers have until that Saturday's lock to pick a team.

   ```bash
   gh workflow run deploy-staging.yml -f target=beta -f seed_beta=true -f first_friday=2027-02-19
   ```

   It migrates the empty database, seeds the game (reference data, our starting prices, no results), opens round 1, starts the clock, publishes the beta notice, and deploys the tick and the site. The seed is one transaction and refuses a database that isn't empty. If it fails, nothing was written and you can run it again. It also refuses a date that isn't a Friday at least a day ahead.

6. **Make yourself an admin.** Sign in on the site and finish signing up, then run **Staff action** with target `beta`, command `set-role`, change `{"username":"<you>","role":"admin"}`, first as a dry run.

7. **Check it.**
   - **Staff → Settings** shows the replay running, on the date you expect.
   - The sign-up page names the beta notice.
   - The home page shows round 1 open, and its lock counts down to the right real time.
   - The `tick` function's log on the `beta` branch shows `republished`, then a wake that runs `sync_calendar`.

Later deploys to the beta leave out `seed_beta` and `first_friday`:

```bash
gh workflow run deploy-staging.yml -f target=beta
```

## The invite list

`SIGN_UP_ALLOWED_EMAILS` holds up to 30 testers, separated by commas. Name a Discord account as `discord:<id>` (in Discord, turn on Developer Mode, then right-click the person and **Copy User ID**). Testers sign in with Discord: `EMAIL_FROM` is Resend's test address, which only delivers to you. Redeploy the site after changing it. The beta notice must be published before the list opens, which step 5 does.

## Running the weekends

The clock is under **Staff → Settings**: Pause, Resume, and Jump. Each needs a reason and is audited.

- **Leave it running.** Paused, "now" stands still, so a rate limit a tester has reached never clears, and nothing locks.
- **A jump goes forward only,** and stops one minute before the next lock on the way. To skip rounds, jump, wait for that lock, and jump again.
- **After each jump, wait for the work to finish before the next one.** The polls, scores and price changes for the weekend you passed run over the next few minutes. Check **Staff → Review** for anything that needs you.
- **Jump to the Thursday of a weekend you want played,** not to its lock, so testers have time to change their teams. To keep the times of day right, jump to the same UTC time of day and the same weekday as now.

| Beta weekend | Round | Why |
| - | - | - |
| 1 | 1, Australia | The first lock. Follows the seed with no jump |
| 2 | 2, China | A sprint weekend. The next week, with no jump |
| 3 | 14, Spain | Drivers with no qualifying time |
| 4 | 19, Mexico City | A substitution and a disqualification |
| 5, if there's time | 23, Abu Dhabi | The season's end |

### Where real time still applies

Sign-in runs on real time: sessions, sign-in links and authenticator codes work as usual, and the security page shows real dates. Everything else the site records is on the replay's clock. That leaves three things to know:

- **Ban with no end date.** Sign-in compares a ban's end with real time, so a ban that ends "in a week" on the replay's clock is already over and is lifted at the next sign-in. Lift it by hand instead. Mutes and chat bans go by the replay's clock and end as they should.
- **A jump ages things.** A data export's link, good for a few days, is gone after a jump of that length (the person can ask again). A sign-up that was never finished is deleted after seven days on the replay's clock, so warn testers to finish before you jump.
- **Time spent paused doesn't count** towards a mute, a rate limit, or the hour a "delete my account" link lasts.

### What staff do, by round

Jolpica's answers need the same staff actions the 2026 season did. Some weekends stay **awaiting** or **under review** until they're done, whether or not they're one of the beta's:

| Round | When, on the replay's clock | Action |
| - | - | - |
| 1 | after qualifying | Enter the drivers with no time: `max_verstappen` 20th (car 3), `sainz` 21st (55), `stroll` 22nd (18) |
| 12 | before its lock | Withdraw `hadjar` from the pool. The seats for rounds 12 to 14 are already in |
| 14 | after qualifying | Enter `bearman` 21st (87) and `stroll` 22nd (18) |
| 19 | before FP3 | Substitute `ryo_hirakawa` for `ocon` at `haas`, car 50 |
| 19 | after qualifying | Disqualify `lawson` from qualifying (position none) |
| 20 | before the weekend | Seat change from round 20: `ocon` out, `rafael_camara` in at `haas`, car 51 |

Use the staff screens, or **Staff action** with target `beta`.

## Ending it

1. Tell the testers. The notice says the data may be wiped.
2. Set the Vercel values from step 4 back to `main`'s, and remove `CLOCK_MODE`.
3. Set `BETA_RUNNING` to anything but `true`.
4. Deploy with `target: main`.
5. Deploy nothing more to `beta`. Its triggers keep firing until the branch goes, so delete it once you have the last backup and have decided the data isn't needed. Deleting it can't be undone.
