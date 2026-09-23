> Production hardening release: follow [DEPLOYMENT.md](DEPLOYMENT.md) first for migration order, three-router scoping, 120-second snapshots, six-minute freshness and command recovery. The single-router examples below remain useful for API-SSL setup.

# MikroTik API-SSL: Vercel + RouterOS 6.49.19

This first integration reads identity, version, uptime, simple queues and queue trees.
The admin page is `/admin/routers`. Queue writes are opt-in; see `MIKROTIK-WRITES.md` for the later write upgrade.
It does not create router subscribers. The existing optional writer enforces suspension through simple-queue rates. Mapped service actions atomically enqueue simple-queue changes; unmapped services remain database-only.

Run the included Python connector on a PC, Raspberry Pi or VM on the router LAN.
It reads the router over API-SSL and uploads a snapshot over HTTPS to Vercel every
120 seconds. Both connections originate from the connector; no WAN port forwarding
or public router IP is needed. RouterOS 6 cannot run this Python program itself.
Use Python 3.10+; no third-party Python packages are required. Keep the host awake.

## 1. Router setup

Examples use router `192.168.88.1` and connector `192.168.88.10`. Substitute your
addresses and reserve the connector's LAN IP. Check the router clock first.
If API-SSL already has a server certificate, reuse it and its issuing CA.
Otherwise create a test CA and server certificate using an existing admin session.
Run once, waiting for each signing operation to finish:

```routeros
/certificate add name=isp-test-ca common-name=isp-test-ca key-size=2048 days-valid=3650 key-usage=key-cert-sign,crl-sign
/certificate sign isp-test-ca name=isp-test-ca
/certificate add name=isp-test-api common-name=router-test.local subject-alt-name=DNS:router-test.local key-size=2048 days-valid=365 key-usage=digital-signature,key-encipherment,tls-server
/certificate sign isp-test-api ca=isp-test-ca name=isp-test-api
/certificate set isp-test-ca trusted=yes
/certificate set isp-test-api trusted=yes
/certificate export-certificate isp-test-ca type=pem
```

Download the exported CA `.crt` from WinBox Files into the connector directory,
renaming it `router-ca.crt`. Only the public CA certificate is needed.
The connector's `tls_server_name` must match the certificate SAN. The example
uses `router-test.local` for verification while connecting by IP; LAN DNS is not needed.

Create a dedicated API account; enter a strong password locally:

```routeros
/user group add name=isp-monitor policy=read,api
/user add name=isp-monitor group=isp-monitor address=192.168.88.10/32 password="REPLACE_WITH_A_STRONG_PASSWORD"
/ip service set api-ssl disabled=no port=8729 certificate=isp-test-api address=192.168.88.10/32
```

The last command replaces the existing API-SSL address allowlist and certificate.
Preserve existing client addresses and trust requirements if other integrations use it.
Ensure the input firewall permits TCP 8729 from the connector before any applicable
drop rule. Keep WAN management access blocked. No NAT port forwarding is needed.

References: [API-SSL](https://help.mikrotik.com/docs/spaces/ROS/pages/47579160/API),
[Certificates](https://help.mikrotik.com/docs/spaces/ROS/pages/2555969/Certificates),
[User policies](https://help.mikrotik.com/docs/spaces/ROS/pages/8978504/User).

## 2. Test locally

Copy `connector/config.example.json` to `connector/config.json`. Enter the router
host, TLS verification name, CA path, username and password. Relative CA paths are
resolved from the config directory. Protect this file with local account permissions;
on Linux/macOS use `chmod 600 connector/config.json`.

From the project directory:

```sh
python3 connector/mikrotik_connector.py --config connector/config.json --local-only
```

On Windows use `py -3` instead of `python3` if needed.
Expected: `Local API-SSL check passed: N queues`. This verifies TLS, login and both
queue reads, without uploading anything. App URL/token are not required in this mode.

## 3. Configure production

Apply `supabase/migrations/20260917003146_mikrotik_telemetry.sql` to the app's Supabase
database after the existing migrations. It stores one latest snapshot per company
and test router. Authenticated clients cannot write it. Only active admins belonging
to the owning company can read it, even where other app features allow cross-company
admin access.

Generate a random token and its hash on your computer:

```sh
python3 -c "import secrets,hashlib; t=secrets.token_urlsafe(32); print('connector_token:',t); print('MIKROTIK_CONNECTOR_TOKEN_SHA256:',hashlib.sha256(t.encode()).hexdigest())"
```

Put the raw token in the connector config, and only its hash in Vercel:

| Vercel environment variable | Value |
| --- | --- |
| `MIKROTIK_CONNECTOR_TOKEN_SHA256` | Generated 64-character hash |
| `MIKROTIK_ORGANIZATION_ID` | UUID of the router's company in `organizations` |
| `SUPABASE_SECRET_KEY` | Existing privileged server key; legacy `SUPABASE_SERVICE_ROLE_KEY` also works |

Existing public Supabase URL/publishable key settings remain required.
Never prefix privileged keys or connector settings with `NEXT_PUBLIC_`.
Confirm your admin account has an active admin membership in the selected company.
Deploy the updated project to your existing Vercel app; redeploy after environment changes.

Set `app_url` in the connector config to the final HTTPS origin, for example
`https://your-project.vercel.app`, with no path. Redirects are rejected to protect the
token. Use the canonical production URL. Vercel Deployment Protection may reject
machine requests independently; this connector does not implement a protection bypass.

## 4. Test the production upload

```sh
python3 connector/mikrotik_connector.py --config connector/config.json --once
```

Expected: `Snapshot uploaded: N queues`. Sign in as the owning company's admin and
open **MikroTik connection test** in the sidebar, or `/admin/routers`. Refresh and
compare identity, RouterOS version, queue names, targets and limits with WinBox.

For continuous collection:

```sh
python3 connector/mikrotik_connector.py --config connector/config.json
```

Use an OS service manager for unattended operation. Stop with Ctrl+C.
The default interval is 120 seconds; refresh the admin page manually. Data is marked
stale after six minutes. Failed collection/upload leaves the last snapshot with its
original timestamp; a recent snapshot does not guarantee current router availability.
Rotate/remove the Vercel token hash and redeploy to revoke uploads.

## Troubleshooting

To identify the failing connection stage without exposing credentials, run:

```sh
python3 connector/mikrotik_connector.py --config connector/config.json --local-only --diagnose
```

On Windows Command Prompt, test the router port with:

```bat
powershell -NoProfile -Command "Test-NetConnection -ComputerName 192.168.88.1 -Port 8729"
```

Replace the example IP with your router LAN IP. A successful TCP test only proves
port reachability; the connector also tests TLS, login and queue reads.


| Symptom | Check |
| --- | --- |
| Timeout/refused | LAN route, IP, port, enabled API-SSL, service allowlist and input firewall |
| TLS verification failure | Issuing CA, SAN vs server name, expiry and both clocks |
| TLS handshake failure | Assigned server certificate/private key and TLS 1.2; do not disable verification |
| Router command rejected | Username/password and `read,api` group |
| HTTP 401 | Token/hash match; also check Deployment Protection |
| HTTP 400 | Payload schema/size; maximum 2,000 queues and 1 MB |
| HTTP 503 | Vercel settings, valid company UUID, migration and Supabase server key |
| HTTP 3xx/404 | Canonical URL and deployment containing the endpoint |
| Upload succeeds, empty admin page | Active admin membership in the configured company; refresh |
| Stale snapshot | Connector stopped, host sleeping, router unavailable or upload rejected |

Credentials remain on the local host. The upload token can write telemetry only for
the company configured on the server; it cannot read app data or issue router commands.
The connector logs counts and generic errors rather than credentials or queue targets.
Snapshots contain network information and are visible only to the scoped admins.
This installation supports one explicitly configured test router. For service-driven
bandwidth commands, follow [MIKROTIK-WRITES.md](MIKROTIK-WRITES.md).

## Before adding subscriber management

Inventory includes simple queues and queue trees so the actual configuration can be
confirmed. Simple-queue max-limit pairs are upload/download from the target's perspective.
Queue trees require understanding their parents and packet marks. See the
[MikroTik queue documentation](https://help.mikrotik.com/docs/spaces/ROS/pages/328088/Queues).

Before writes, explicitly map subscribers to router queues and verify targets and
dynamic status. Suspension applies the 1k queue profile described in
[MIKROTIK-WRITES.md](MIKROTIK-WRITES.md); verify its result on the router.

## Verification

The production build, TypeScript checks, Node tests and Python connector tests
verify the packaged code. Complete the local and upload checks above to verify
your own Vercel, Supabase and RouterOS setup.
