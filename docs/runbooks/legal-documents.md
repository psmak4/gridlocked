# Publishing a legal document

The approved text of a legal document lives in `src/identity/legal-text.ts`
and shows at `/legal/<kind>`. Publishing records the version in
`legal_documents` for one environment, so the sign-up box names it and every
account is asked to accept it.

Only the beta notice (`beta-1`, approved 2026-11-23) has text so far. The
terms, privacy policy and community rules still show the draft placeholder.

## The beta notice

It's published per environment, never by a migration, so it never reaches
production. Run it once against the beta branch (Task 13's beta deploy does
this, with the owner's OK):

```bash
CLOCK_MODE=replay DATABASE_URL=<beta branch> pnpm legal:publish beta
```

- It's dated at that database's "now": on a replay database, the replay
  clock, so it's in force there at once.
- Running it again writes nothing.
- Once it's in force, the sign-up box reads "Terms, Privacy Policy, Community
  rules and Beta notice". Anyone already signed up is sent to finish signing
  up and accept it before they can play.
