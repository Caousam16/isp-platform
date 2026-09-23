import { LoginForm } from "@/components/login-form";
import { isConfigured } from "@/lib/supabase/server";

export default function StaffLoginPage() {
  return (
    <main className="auth-page staff-auth">
      <section className="auth-card">
        <a className="brand dark-brand" href="/">
          SOUTHWOODS<span>CABLE AND INTERNET</span>
        </a>
        <p className="eyebrow">OPERATIONS ACCESS</p>
        <h1>Staff and admin sign-in.</h1>
        <p>Use the email address assigned to your staff account.</p>
        <LoginForm configured={isConfigured()} mode="staff" />
        <a className="text-link" href="/login/subscriber">
          Subscriber sign-in →
        </a>
        <a className="text-link muted-link" href="/login">
          ← Choose another sign-in
        </a>
      </section>
    </main>
  );
}
