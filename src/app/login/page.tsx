import { LoginForm } from "@/components/login-form";
import { isConfigured } from "@/lib/supabase/server";

export default function Login() {
  return (
    <main className="auth-page subscriber-auth">
      <section className="auth-card">
        <a className="brand dark-brand" href="/">
          SOUTHWOODS<span>CABLE AND INTERNET</span>
        </a>
        <p className="eyebrow">CUSTOMER PORTAL</p>
        <h1>Subscriber sign-in.</h1>
        <p>Use the account number printed on your SOUTHWOODS statement.</p>
        <LoginForm configured={isConfigured()} mode="subscriber" />
        <a className="text-link" href="/demo">
          Explore the sample workspace →
        </a>
      </section>
    </main>
  );
}
