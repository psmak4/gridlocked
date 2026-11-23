/**
 * The text of the legal documents that are past their draft, and what
 * `publishDocument` records for each. Only the beta notice so far (decision 5,
 * approved by the owner on 2026-11-23); the others still show the draft
 * placeholder.
 *
 * Publishing is per environment (`pnpm legal:publish beta`), never a
 * migration, so the beta notice never reaches production.
 */

export type LegalSection = { heading?: string; body: string };

export const BETA_NOTICE = {
  kind: "beta",
  version: "beta-1",
  url: "/legal/beta",
  requiresReacceptance: false,
} as const;

export const BETA_NOTICE_TEXT: readonly LegalSection[] = [
  {
    body: "Gridlocked is in a closed beta. You're here because you were invited, and you sign in with Discord.",
  },
  {
    heading: "It replays the 2026 season.",
    body: "The races, results and prices are real ones from 2026, played back on a clock set so race weekends land on real weekends. Nothing here is live, and the results already happened.",
  },
  {
    heading: "Things will break.",
    body: "Expect bugs, slow pages and changes between weekends. Please report problems in the Discord.",
  },
  {
    heading: "What we keep.",
    body: "When something breaks, an error report goes to our error tracker (Sentry). It holds the kind of error and the page it happened on. It doesn't include your name, your email, or anything you typed. The database is backed up every night, encrypted.",
  },
  {
    heading: "Your account may not carry over.",
    body: "The beta may be reset, and beta accounts, teams, leagues and posts may not move to the launch.",
  },
  {
    heading: "Gridlocked is an independent fan site.",
    body: "It isn't affiliated with Formula 1 or its official fantasy game.",
  },
];

/** Each document that can be published, by kind. */
export const PUBLISHABLE = { beta: BETA_NOTICE } as const;
