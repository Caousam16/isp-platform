"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="auth-page">
      <section className="auth-card">
        <h1>Workspace unavailable</h1>
        <p>
          Your data could not be loaded. Confirm the database migration and
          account membership are configured, then retry.
        </p>
        <button onClick={reset}>Try again</button>
        <a href="/login">Back to sign in</a>
      </section>
    </main>
  );
}
