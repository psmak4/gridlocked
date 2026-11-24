/**
 * The browser's error reporting (M9 Task 10, decision 3): Sentry's TanStack
 * Start SDK, loaded only when the build has a DSN, so local runs, tests and
 * CI never load it. Errors only: no tracing, no replay, no feedback, and
 * `scrub` is `beforeSend`, so an event leaves with its class, its frames, the
 * release and the route's pattern ("/u/$username", never the address), and
 * nothing a person typed or is.
 */
import type { AnyRouter } from "@tanstack/react-router";
import { scrub, type ReportEvent } from "./report-error";

type Sdk = typeof import("@sentry/tanstackstart-react");

let sdk: Sdk | undefined;

/** The route the page is on, as its pattern. */
function routePattern(router: AnyRouter): string | undefined {
  const matches = router.state.matches as { routeId?: string }[];
  return matches.at(-1)?.routeId;
}

export type ClientReportingOptions = {
  dsn?: string;
  release?: string;
  environment?: string;
  /** For tests: the SDK to start. */
  load?: () => Promise<Sdk>;
};

/** Starts Sentry in the browser, when there's a DSN. */
export async function startClientReporting(
  router: AnyRouter,
  options: ClientReportingOptions = {
    dsn: import.meta.env.VITE_SENTRY_DSN as string | undefined,
    release: import.meta.env.VITE_SENTRY_RELEASE as string | undefined,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT as string | undefined,
  },
): Promise<void> {
  if (!options.dsn || sdk) return;
  const Sentry = await (
    options.load ?? (() => import("@sentry/tanstackstart-react"))
  )();
  Sentry.init({
    dsn: options.dsn,
    release: options.release,
    environment: options.environment,
    // Collect nothing about the person or the request; scrub is the backstop.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
    },
    beforeSend(event) {
      const route = routePattern(router);
      if (route) event.tags = { ...event.tags, route };
      // The SDK's own event type, through the same allowlist.
      return scrub(event as unknown as ReportEvent) as unknown as
        typeof event | null;
    },
    // Breadcrumbs keep their kind only; scrub drops the rest when an event goes.
    beforeBreadcrumb: (crumb) => ({
      timestamp: crumb.timestamp,
      category: crumb.category,
      level: crumb.level,
      type: crumb.type,
    }),
  });
  sdk = Sentry;
}

/** An error a route's boundary caught: React's boundaries keep it from the SDK's own handlers. */
export function reportClientError(error: unknown): void {
  sdk?.captureException(error);
}
