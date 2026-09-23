"use client";

import { useState } from "react";
import { subscriberLoginEmail } from "@/lib/domain";
import { createClient } from "@/lib/supabase/client";

export function LoginForm({
  configured,
  mode,
}: {
  configured: boolean;
  mode: "subscriber" | "staff";
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  if (!configured) {
    return (
      <div className="notice">
        Live sign-in is not configured. Add the Supabase URL and publishable key
        from your project to enable it. No demo credentials are needed.
      </div>
    );
  }

  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setMessage("");
        const form = new FormData(event.currentTarget);

        try {
          const email =
            mode === "subscriber"
              ? subscriberLoginEmail(String(form.get("account_number")))
              : String(form.get("email")).trim().toLowerCase();
          const { error } = await createClient().auth.signInWithPassword({
            email,
            password: String(form.get("password")),
          });
          if (error) {
            setMessage(
              mode === "subscriber"
                ? "Account number or password is incorrect."
                : "Email or password is incorrect.",
            );
            return;
          }
          window.location.assign(mode === "subscriber" ? "/portal" : "/admin");
        } catch {
          setMessage(
            mode === "subscriber"
              ? "Enter a valid account number."
              : "Unable to sign in. Try again shortly.",
          );
        } finally {
          setBusy(false);
        }
      }}
    >
      {mode === "subscriber" ? (
        <label>
          Account number
          <input
            name="account_number"
            type="text"
            autoComplete="username"
            autoCapitalize="characters"
            placeholder="SW-000123"
            pattern="[A-Za-z0-9-]{3,30}"
            required
          />
        </label>
      ) : (
        <label>
          Email address
          <input name="email" type="email" autoComplete="username" required />
        </label>
      )}
      <label>
        Password
        <input
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </label>
      <p role="status" className="form-message">
        {message}
      </p>
      <button disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
      <small>
        {mode === "subscriber"
          ? "Use the account number issued by SOUTHWOODS."
          : "Staff accounts are provisioned by an administrator."}{" "}
        Passwords are securely handled by Supabase Auth.
      </small>
    </form>
  );
}
