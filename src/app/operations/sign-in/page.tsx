import { LoginForm } from "@/components/login-form";
import { isConfigured } from "@/lib/supabase/server";

export default function OperationsLoginPage() {
  return (
    <main className="auth-page operations-auth">
      <section className="auth-card">
        <a className="brand dark-brand" href="/operations/sign-in">
          SOUTHWOODS<span>CABLE AND INTERNET</span>
        </a>
        <p className="eyebrow">AUTHORIZED OPERATIONS</p>
        <h1>Team sign-in.</h1>
        <p>Use the email address assigned to your operations account.</p>
        <LoginForm configured={isConfigured()} mode="staff" />
      </section>
    </main>
  );
}
