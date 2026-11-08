import type { EMAIL_TEMPLATES } from "@/db/schema";

export type EmailTemplate = (typeof EMAIL_TEMPLATES)[number];

/** Every template carries one link. Stored in the outbox row until it is sent. */
export interface EmailPayload {
  url: string;
}

/** The site footer's wording (src/components/site-footer.tsx). */
export const DISCLAIMER =
  "Unofficial. Not affiliated with Formula 1 or the FIA.";

const COPY: Record<
  EmailTemplate,
  { subject: string; intro: string; action: string }
> = {
  verify_email: {
    subject: "Confirm your email for Gridlocked",
    intro:
      "Confirm your email address to finish setting up your Gridlocked account.",
    action: "Confirm your email",
  },
  magic_link: {
    subject: "Your Gridlocked sign-in link",
    intro:
      "Use this link to sign in to Gridlocked. It works once and expires soon.",
    action: "Sign in",
  },
  password_reset: {
    subject: "Reset your Gridlocked password",
    intro:
      "Use this link to choose a new password. If you didn't ask for it, you can ignore this email.",
    action: "Reset your password",
  },
  email_change_notice: {
    subject: "The email on your Gridlocked account changed",
    intro:
      "The email address on your Gridlocked account was changed. If that wasn't you, use this link to secure your account.",
    action: "Secure your account",
  },
  delete_confirm: {
    subject: "Confirm deleting your Gridlocked account",
    intro:
      "Use this link to confirm deleting your account. If you didn't ask for this, you can ignore this email.",
    action: "Confirm deletion",
  },
  export_ready: {
    subject: "Your Gridlocked data export is ready",
    intro:
      "The copy of your Gridlocked data you asked for is ready. The link works for 7 days.",
    action: "Download your data",
  },
};

const escapeHtml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** Plain text and HTML for a template. Both end with the disclaimer. */
export function renderEmail(
  template: EmailTemplate,
  payload: EmailPayload,
): { subject: string; text: string; html: string } {
  const { subject, intro, action } = COPY[template];
  const url = escapeHtml(payload.url);
  const text = `${intro}\n\n${action}: ${payload.url}\n\n${DISCLAIMER}\n`;
  const html = `<!doctype html>
<html>
<body>
<p>${escapeHtml(intro)}</p>
<p><a href="${url}">${escapeHtml(action)}</a></p>
<p>${url}</p>
<p>${escapeHtml(DISCLAIMER)}</p>
</body>
</html>
`;
  return { subject, text, html };
}
