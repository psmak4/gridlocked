import type { ReactNode } from "react";
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
  redirect,
} from "@tanstack/react-router";
import { ImpersonationBanner } from "@/components/impersonation-banner";
import { SiteFooter } from "@/components/site-footer";
import { ThemeScript } from "@/components/theme-script";
import { gateRedirect } from "@/lib/auth-gate";
import { privateHeaders } from "@/lib/private-headers";
import { getAccount } from "@/server/account";
import appCss from "@/styles/globals.css?url";

export const Route = createRootRoute({
  // The signed-in gate. With no session cookie `getAccount` answers null
  // without touching the database, and a logged-out visitor is never
  // redirected, so public pages stay public and cacheable.
  beforeLoad: async ({ location }) => {
    const account = await getAccount();
    const to = gateRedirect(location.pathname, account);
    if (to) throw redirect({ to });
    return { account };
  },
  // A page built for someone signed in is for them alone.
  headers: ({ match }) =>
    match.context.account ? privateHeaders() : undefined,
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Gridlocked" },
      {
        name: "description",
        content:
          "An unofficial fan home for race weekends: forum, live chat and a fantasy game.",
      },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", href: "/favicon.ico" },
    ],
  }),
  shellComponent: RootDocument,
  component: RootComponent,
  notFoundComponent: NotFound,
});

/** Every page, with the impersonation banner on top while one is running. */
function RootComponent() {
  const { account } = Route.useRouteContext();
  return (
    <>
      {account?.impersonated ? (
        <ImpersonationBanner username={account.username ?? ""} />
      ) : null}
      <Outlet />
    </>
  );
}

function NotFound() {
  return (
    <main className="p-space-4">
      <h1 className="font-display text-[32px] uppercase">Page not found</h1>
    </main>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeScript />
        <HeadContent />
      </head>
      <body className="bg-surface text-ink font-sans">
        {children}
        <SiteFooter />
        <Scripts />
      </body>
    </html>
  );
}
