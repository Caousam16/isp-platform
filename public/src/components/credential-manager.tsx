"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  KeyRound,
  RotateCcw,
  ShieldCheck,
  UserPlus,
  UsersRound,
} from "lucide-react";
import {
  createStaffCredential,
  createSubscriberCredential,
  resetSubscriberPassword,
} from "@/app/admin/access/actions";
import type { Role } from "@/lib/domain";

type OrganizationOption = { id: string; name: string };
type SubscriberOption = { id: string; organization_id: string; account_number: string; name: string };
type Result = { success?: string; error?: string };
type CredentialMode = "staff" | "subscriber";

function ResultMessage({ result }: { result: Result }) {
  if (!result.error && !result.success) return null;
  return (
    <p
      role={result.error ? "alert" : "status"}
      className={result.error ? "form-message" : "form-success"}
    >
      {result.error ?? result.success}
    </p>
  );
}

export function CredentialManager({
  role,
  organizations,
  subscribers,
  linkedSubscribers,
  provisioningConfigured,
}: {
  role: Role;
  organizations: OrganizationOption[];
  subscribers: SubscriberOption[];
  linkedSubscribers: SubscriberOption[];
  provisioningConfigured: boolean;
}) {
  const router = useRouter();
  const [credentialMode, setCredentialMode] = useState<CredentialMode>(
    role === "admin" ? "staff" : "subscriber",
  );
  const [staffResult, setStaffResult] = useState<Result>({});
  const [subscriberResult, setSubscriberResult] = useState<Result>({});
  const [resetResult, setResetResult] = useState<Result>({});
  const [busy, setBusy] = useState<"staff" | "subscriber" | "reset" | null>(null);
  const organizationName = (id: string) =>
    organizations.find((organization) => organization.id === id)?.name ?? "Company";

  async function submitStaff(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy("staff");
    setStaffResult({});
    try {
      const values = Object.fromEntries(new FormData(form));
      const result = await createStaffCredential(values);
      setStaffResult(result);
      if (result.success) form.reset();
    } catch {
      setStaffResult({ error: "Could not create the staff login. Try again." });
    } finally {
      setBusy(null);
    }
  }

  async function submitReset(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy("reset");
    setResetResult({});
    try {
      const values = Object.fromEntries(new FormData(form));
      const result = await resetSubscriberPassword(values);
      setResetResult(result);
      if (result.success) form.reset();
    } catch {
      setResetResult({ error: "Could not reset the subscriber password. Try again." });
    } finally {
      setBusy(null);
    }
  }

  async function submitSubscriber(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setBusy("subscriber");
    setSubscriberResult({});
    try {
      const values = Object.fromEntries(new FormData(form));
      const result = await createSubscriberCredential(values);
      setSubscriberResult(result);
      if (result.success) {
        form.reset();
        router.refresh();
      }
    } catch {
      setSubscriberResult({
        error: "Could not create the subscriber login. Try again.",
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="access-page">
      <div className="access-header">
        <div>
          <a href="/admin" className="back-link">
            <ArrowLeft size={17} /> Back to workspace
          </a>
          <p className="eyebrow">SECURE ACCESS</p>
          <h1>Account credentials</h1>
          <p>Create and reset logins permitted by your current {role} role.</p>
        </div>
        <div className="foundation access-security">
          <ShieldCheck size={20} />
          <span>
            Server-only provisioning
            <small>Passwords are stored only by Supabase Auth</small>
          </span>
        </div>
      </div>

      {!provisioningConfigured && (
        <div className="notice" role="alert">
          Add SUPABASE_SECRET_KEY to the server environment before creating
          credentials. Never prefix this secret with NEXT_PUBLIC_.
        </div>
      )}

      {role === "admin" && (
        <div className="credential-mode" role="group" aria-label="Credential type">
          <button
            type="button"
            aria-pressed={credentialMode === "staff"}
            className={credentialMode === "staff" ? "selected" : undefined}
            onClick={() => setCredentialMode("staff")}
          >
            <UserPlus size={18} /> Staff credentials
          </button>
          <button
            type="button"
            aria-pressed={credentialMode === "subscriber"}
            className={credentialMode === "subscriber" ? "selected" : undefined}
            onClick={() => setCredentialMode("subscriber")}
          >
            <UsersRound size={18} /> Subscriber credentials
          </button>
        </div>
      )}

      {role === "admin" && credentialMode === "staff" && (
        <div
          className="access-grid access-grid-single"
        >
          <section className="panel credential-card">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">ADMIN ONLY</p>
                <h2><UserPlus size={20} /> Create staff login</h2>
                <p>The staff member signs in using this email and password.</p>
              </div>
            </div>
            <form onSubmit={submitStaff}>
              <label>
                Coverage company
                <select name="organization_id" required defaultValue="">
                  <option value="" disabled>Select a company</option>
                  {organizations.map((organization) => (
                    <option key={organization.id} value={organization.id}>{organization.name}</option>
                  ))}
                </select>
              </label>
              <label>
                Staff name
                <input name="name" minLength={2} maxLength={120} required />
              </label>
              <label>
                Staff email
                <input name="email" type="email" autoComplete="off" required />
              </label>
              <div className="form-row">
                <label>
                  Initial password
                  <input name="password" type="password" minLength={12} maxLength={72} autoComplete="new-password" required />
                </label>
                <label>
                  Confirm password
                  <input name="confirm_password" type="password" minLength={12} maxLength={72} autoComplete="new-password" required />
                </label>
              </div>
              <ResultMessage result={staffResult} />
              <button disabled={busy !== null || !provisioningConfigured}>
                {busy === "staff" ? "Creating…" : "Create staff credentials"}
              </button>
            </form>
          </section>
        </div>
      )}

      {credentialMode === "subscriber" && (
        <div
          className="access-grid"
        >
          <section className="panel credential-card">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">STAFF AND ADMIN</p>
              <h2><KeyRound size={20} /> Create subscriber login</h2>
              <p>The subscriber signs in using their account number.</p>
            </div>
          </div>
          {subscribers.length ? (
            <form onSubmit={submitSubscriber}>
              <label>
                Subscriber without a login
                <select name="subscriber_id" required defaultValue="">
                  <option value="" disabled>Select a subscriber</option>
                  {subscribers.map((subscriber) => (
                    <option key={subscriber.id} value={subscriber.id}>
                      {subscriber.account_number} — {subscriber.name} · {organizationName(subscriber.organization_id)}
                    </option>
                  ))}
                </select>
              </label>
              <div className="form-row">
                <label>
                  Initial password
                  <input name="password" type="password" minLength={12} maxLength={72} autoComplete="new-password" required />
                </label>
                <label>
                  Confirm password
                  <input name="confirm_password" type="password" minLength={12} maxLength={72} autoComplete="new-password" required />
                </label>
              </div>
              <ResultMessage result={subscriberResult} />
              <button disabled={busy !== null || !provisioningConfigured}>
                {busy === "subscriber" ? "Creating…" : "Create subscriber credentials"}
              </button>
            </form>
          ) : (
            <p className="empty">Every subscriber already has a login, or no subscriber records exist yet.</p>
          )}
          </section>

          <section className="panel credential-card">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">STAFF AND ADMIN</p>
              <h2><RotateCcw size={20} /> Reset subscriber password</h2>
              <p>Set a new password for a subscriber who already has a login.</p>
            </div>
          </div>
          {linkedSubscribers.length ? (
            <form onSubmit={submitReset}>
              <label>
                Subscriber with a login
                <select name="subscriber_id" required defaultValue="">
                  <option value="" disabled>Select a subscriber</option>
                  {linkedSubscribers.map((subscriber) => (
                    <option key={subscriber.id} value={subscriber.id}>
                      {subscriber.account_number} — {subscriber.name} · {organizationName(subscriber.organization_id)}
                    </option>
                  ))}
                </select>
              </label>
              <div className="form-row">
                <label>
                  New password
                  <input name="password" type="password" minLength={12} maxLength={72} autoComplete="new-password" required />
                </label>
                <label>
                  Confirm password
                  <input name="confirm_password" type="password" minLength={12} maxLength={72} autoComplete="new-password" required />
                </label>
              </div>
              <small className="password-help">Use at least 12 characters and share the new password through a private channel.</small>
              <ResultMessage result={resetResult} />
              <button disabled={busy !== null || !provisioningConfigured}>
                {busy === "reset" ? "Resetting…" : "Reset subscriber password"}
              </button>
            </form>
          ) : (
            <p className="empty">No active subscriber login is available to reset.</p>
          )}
          </section>
        </div>
      )}

      <p className="credential-note">
        Share initial and reset passwords through a private channel. Passwords
        are never stored in application tables. A reset changes future sign-ins;
        existing sessions may remain active until their access token expires.
      </p>
    </main>
  );
}
