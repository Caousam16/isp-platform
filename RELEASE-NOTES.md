# Existing-feature hardening report

Base: `Caousam16/isp-platform`, commit `d321fc9bf4333480f92db4dd4e080a913a782d61`.

## Findings addressed

| Finding in the base source | Change |
| --- | --- |
| Hard-coded single-router scope | Server-only per-router token scopes; router/company scoped ingest, claims, results, mappings and admin views |
| Dashboard data silently stopped at 500 records | Paged, RLS-authorized reads; explicit collection limit; bounded table rendering; complete loaded-data search and export |
| Telemetry performed one HTTP database update per linked subscriber | One transactional ingest RPC, set-based identity refresh, changed-row updates, out-of-order snapshot rejection |
| Idle connector loop collected a second full snapshot even without a job | Separate 120-second snapshots and 10-second command checks; post-command refresh; backoff and jitter |
| Service mutation committed before router job creation | Atomic database trigger for mapped services, with fresh identity checks and rollback on enqueue failure |
| Staff lifecycle authorization too broad; historical direct update path | Staff suspension only; admin-only other transitions; direct status/plan update grants revoked |
| Admin business reads/writes bypassed RLS | Authenticated client for normal workspace and subscriber/plan/service operations; privileged client restricted to server-only tasks |
| Interrupted job could indefinitely block a router; unsupported result code could prevent acknowledgement | Five-minute uncertain transition without replay; scoped claims; late result acknowledgement; supported uncertainty code and private checkpoint files |
| Invoice/payment retry could duplicate a successful operation after a lost response | Transactional request IDs, input/actor comparison and access recheck before returning cached result |
| Duplicate historical migrations broke a fresh database | Compatibility guards plus a tested forward migration; existing migration identities retained |
| Password form reset after await used an expired event target | Capture the form before awaiting |
| Dependency and runtime drift | Exact direct dependency versions matching lockfile; Node 24 CI, Python connector tests, production environment preflight |

The original group-wide administrator access remains intentional. Staff and subscriber access remain company/account scoped. The existing simple-queue plan profile and 1k suspension profile are retained. No new billing module, monitoring product, Redis service or queueing infrastructure was added.

## Verification

- 47 Node/database tests passed, including the full migration chain on PGlite and a synthetic 3-router × 1,000-subscriber fixture.
- The fixture verifies all 3,000 queue mappings, unchanged-row preservation, router isolation, stale-state rollback, role restrictions, uncertain command behavior, and invoice/payment idempotency.
- 13 Python tests passed, including a local TLS RouterOS-protocol fixture and interrupted-write acknowledgement behavior.
- TypeScript check and optimized Next.js production build passed.
- Production server HTTP smoke checks returned 200 for `/`, `/demo`, `/login`, and `/operations/sign-in`; the demo response included the expected security header.
- Production configuration preflight rejected an unconfigured environment and accepted a synthetic complete configuration. This does not validate real keys.
- `npm audit --omit=dev` reported zero known production dependency vulnerabilities at verification time.

## Verification limits and release gate

Automated interactive browser testing could not run: the browser installer failed certificate verification when fetching its browser version manifest. HTTP smoke checks do not substitute for browser interaction tests.

PGlite tests stub Supabase Auth claims. No real Supabase Auth credentials, production database, router hardware, connector host service manager, Vercel account or concurrent-user load test was used. This package is a hardened release candidate; complete the staging acceptance list in DEPLOYMENT.md before enabling production writes. Do not treat a queued service change as proof that router bandwidth has changed.

Workspace search and totals still process loaded data, with a 50,000-row maximum per collection. The tests establish correctness for 3,000 network identities, not an unlimited-history or latency guarantee. The audit view continues to show its existing latest 50 events. Billing request IDs protect retries of the same form; reopening a form starts a new request.

## Required upgrade

Read DEPLOYMENT.md. Back up first, stop old connectors, apply `20260922084015_production_hardening.sql`, deploy/rebuild the updated application and connector together, verify read-only snapshots, then complete controlled write checks. Preserve local secrets, certificates and pending result checkpoints. The ZIP has no enclosing folder and is designed to overwrite matching project files.
