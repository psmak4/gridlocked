import { createFileRoute, redirect } from "@tanstack/react-router";

// "Secure your account" in the notice to an old address points here.
export const Route = createFileRoute("/forgot-password")({
  beforeLoad: () => {
    throw redirect({ to: "/reset-password" });
  },
});
