import { createFileRoute, notFound } from "@tanstack/react-router";
import {
  BackLink,
  Body,
  Screen,
  ScreenHeader,
  Title,
} from "@/components/account-layout";

const DOCUMENTS: Record<string, string> = {
  terms: "Terms",
  privacy: "Privacy Policy",
  community_rules: "Community rules",
};

export const Route = createFileRoute("/legal/$kind")({
  beforeLoad: ({ params }) => {
    if (!(params.kind in DOCUMENTS)) throw notFound();
  },
  head: ({ params }) => ({
    meta: [{ title: `${DOCUMENTS[params.kind] ?? "Legal"} · Gridlocked` }],
  }),
  component: LegalDocument,
});

function LegalDocument() {
  const { kind } = Route.useParams();
  return (
    <Screen>
      <ScreenHeader>
        <BackLink href="/" />
      </ScreenHeader>
      <Body>
        <Title>{DOCUMENTS[kind]}</Title>
        <p className="text-[14px] font-bold tracking-[0.12em] text-ink-muted">
          DRAFT 1
        </p>
        <p className="text-[16px] leading-[24px]">
          This document is still a draft. The version you accept is recorded
          with the date you accepted it, and you will be asked again if it
          changes in a way that matters.
        </p>
      </Body>
    </Screen>
  );
}
