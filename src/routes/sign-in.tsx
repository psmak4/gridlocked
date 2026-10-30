import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { authClient } from "@/spike/auth-client";
import { cacheControl } from "@/spike/cache";

export const Route = createFileRoute("/sign-in")({
  headers: () => ({ "Cache-Control": cacheControl("private") }),
  head: () => ({ meta: [{ title: "Sign in · Gridlocked" }] }),
  component: SignIn,
});

function SignIn() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email"));
    const password = String(form.get("password"));
    const signUp =
      (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") ===
      "sign-up";
    const result = signUp
      ? await authClient.signUp.email({ email, password, name: email })
      : await authClient.signIn.email({ email, password });
    if (result.error) {
      setError(result.error.message ?? "That didn't work.");
      return;
    }
    await router.navigate({ to: "/me" });
  }

  return (
    <main className="p-space-4">
      <h1 className="font-display text-[32px] uppercase">Sign in</h1>
      <form onSubmit={submit}>
        <label>
          Email <input name="email" type="email" required />
        </label>
        <label>
          Password{" "}
          <input name="password" type="password" minLength={8} required />
        </label>
        <button type="submit" value="sign-in">
          Sign in
        </button>
        <button type="submit" value="sign-up">
          Sign up
        </button>
      </form>
      {error ? <p role="alert">{error}</p> : null}
    </main>
  );
}
