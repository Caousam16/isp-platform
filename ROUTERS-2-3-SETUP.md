# Add Router 2 and Router 3

The application already routes uploads and commands by authenticated `routerKey` and `organizationId`. Connector JSON files intentionally have no router key: the server assigns each connector's scope from its unique token hash. Apply the database migrations in `DEPLOYMENT.md` before enabling the new connectors; in particular, confirm `ingest_mikrotik_snapshot` exists. A missing RPC caused earlier 503 snapshot uploads.

## 1. Prepare each router

Use `MIKROTIK-SETUP.md` to create an API-SSL account, configure its certificate and permit TCP 8729 **only from its connector host**. Install that router's CA certificate on its connector host. Verify that `tls_server_name` matches the certificate SAN; do not disable TLS verification. The connector host needs outbound HTTPS access to the app. It can be a separate machine per router or one machine that can reach all three router LAN addresses.

## 2. Configure the server

Generate a separate random token for each new router on the connector host:

```sh
python3 -c "import secrets,hashlib; t=secrets.token_urlsafe(32); print('connector token:',t); print('server SHA256:',hashlib.sha256(t.encode()).hexdigest())"
```

In Vercel production environment settings, set `MIKROTIK_ROUTERS_JSON` to **one compact JSON string** (substitute real UUIDs and hashes):

```json
[{"routerKey":"local-test","organizationId":"EXISTING_COMPANY_UUID","tokenSha256":"EXISTING_ROUTER_1_HASH"},{"routerKey":"router-2","organizationId":"ROUTER_2_COMPANY_UUID","tokenSha256":"ROUTER_2_HASH"},{"routerKey":"router-3","organizationId":"ROUTER_3_COMPANY_UUID","tokenSha256":"ROUTER_3_HASH"}]
```

Copy the **existing Router 1** organization ID, router key and token hash into the first entry. If its key differs from `local-test`, retain its actual existing key. If all three routers serve the same company, reuse that company's UUID for all entries; otherwise use each router's actual company UUID. Never reuse tokens or hashes. The JSON setting takes precedence over the old single-router environment variables, so leaving Router 1 out would stop its connector from authenticating. Redeploy after updating the environment. Run `npm run check:production` with the production environment available.

## 3. Configure the two new connectors

Copy `connector/config.router-2.example.json` to `connector/config.router-2.json`, and likewise for Router 3. Fill in each router's reachable LAN IP, certificate SAN, CA path, API-SSL username/password, and the **raw token** matching that router's server-side hash. The actual config files and CA certificates are ignored by Git. On a shared host, each config path has its own lock and `.result.json` checkpoint. Preserve these checkpoint files across restarts. Protect config files so only the connector service account can read them.

The sample `app_url` is the known production URL; change it if the active deployment uses another origin. Keep `enable_writes` false for initial setup.

## 4. Verify independently

From the connector host, with Python 3.12 and dependencies from `MIKROTIK-SETUP.md`:

```sh
python3 connector/mikrotik_connector.py --config connector/config.router-2.json --once --diagnose
python3 connector/mikrotik_connector.py --config connector/config.router-3.json --once --diagnose
```

Confirm both uploads succeed and `/admin/routers` shows separate recent snapshots with the correct companies, DHCP leases and queues. Compare a few MAC/IP pairs to each physical router. Run each connector as a persistent service using its own config path:

```sh
python3 connector/mikrotik_connector.py --config connector/config.router-2.json
python3 connector/mikrotik_connector.py --config connector/config.router-3.json
```

Start the processes at different times to distribute 120-second snapshot load. Only set `enable_writes` true after verifying mappings and following the write-account and readback checks in `MIKROTIK-WRITES.md`. Check Router 1 still uploads after the Vercel environment change.
