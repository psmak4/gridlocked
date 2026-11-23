import { createFileRoute, notFound } from "@tanstack/react-router";
import {
  BackLink,
  Body,
  Screen,
  ScreenHeader,
  Title,
} from "@/components/account-layout";
import { LegalText } from "@/components/legal-document";

const DOCUMENTS: Record<string, string> = {
  terms: "Terms",
  privacy: "Privacy Policy",
  community_rules: "Community rules",
  beta: "Beta notice",
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
        <LegalText kind={kind} />
      </Body>
    </Screen>
  );
}
