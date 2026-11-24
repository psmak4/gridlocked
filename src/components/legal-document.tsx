import { BETA_NOTICE_TEXT, type LegalSection } from "@/identity/legal-text";

/** The approved text of each document past its draft. */
const TEXT: Record<string, readonly LegalSection[]> = {
  beta: BETA_NOTICE_TEXT,
};

/** A legal document's body: its approved text, or the draft placeholder. */
export function LegalText({ kind }: { kind: string }) {
  const sections = TEXT[kind];
  if (!sections) {
    return (
      <>
        <p className="text-[14px] font-bold tracking-[0.12em] text-ink-muted">
          DRAFT 1
        </p>
        <p className="text-[16px] leading-[24px]">
          This document is still a draft. The version you accept is recorded
          with the date you accepted it, and you will be asked again if it
          changes in a way that matters.
        </p>
      </>
    );
  }
  return (
    <>
      {sections.map((section) => (
        <p key={section.body} className="text-[16px] leading-[24px]">
          {section.heading ? (
            <>
              <strong>{section.heading}</strong>{" "}
            </>
          ) : null}
          {section.body}
        </p>
      ))}
    </>
  );
}
