import { z } from "zod";
import { validConnectorToken } from "./mikrotik.ts";
export const routerKeySchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const scope = z.object({routerKey:routerKeySchema, organizationId:z.uuid(), tokenSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export function configuredRouters(env: Record<string,string|undefined> = process.env) {
 if (env.MIKROTIK_ROUTERS_JSON?.trim()) {
  const scopes=z.array(scope).min(1).max(32).parse(JSON.parse(env.MIKROTIK_ROUTERS_JSON));
  if(new Set(scopes.map(s=>s.routerKey)).size!==scopes.length || new Set(scopes.map(s=>s.tokenSha256)).size!==scopes.length) throw new Error("Router keys and tokens must be unique");
  return scopes;
 }
 const legacy=scope.safeParse({routerKey:"local-test",organizationId:env.MIKROTIK_ORGANIZATION_ID,tokenSha256:env.MIKROTIK_CONNECTOR_TOKEN_SHA256});
 return legacy.success ? [legacy.data] : [];
}
export function authenticateRouter(header:string|null, scopes:ReturnType<typeof configuredRouters>) {return scopes.find(s=>validConnectorToken(header,s.tokenSha256))??null;}
export function isSnapshotFresh(timestamp:string|null|undefined, now=Date.now()) {const t=Date.parse(timestamp??"");return Number.isFinite(t)&&t<=now+60_000&&now-t<=360_000;}
