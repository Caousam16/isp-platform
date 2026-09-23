import {existsSync} from 'node:fs';
import {configuredRouters} from '../src/lib/mikrotik-config.ts';
for(const file of ['.env.local','.env'])if(existsSync(file))process.loadEnvFile(file);
const required=process.argv.includes('--require-live')||process.env.VERCEL_ENV==='production';
if(!required){console.log('Local/demo build. Run npm run check:production with production environment before release.');process.exit(0);}
try{
 const env=process.env;
 for(const key of ['NEXT_PUBLIC_SUPABASE_URL','NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY','NEXT_PUBLIC_APP_URL'])if(!env[key]?.trim())throw new Error('Missing '+key);
 if(!(env.SUPABASE_SECRET_KEY||env.SUPABASE_SERVICE_ROLE_KEY)?.trim())throw new Error('Missing server-side Supabase secret');
 for(const key of ['NEXT_PUBLIC_SUPABASE_URL','NEXT_PUBLIC_APP_URL']){
  const u=new URL(env[key]);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||!['','/'].includes(u.pathname))throw new Error(key+' must be an HTTPS origin');
 }
 if(!configuredRouters().length)throw new Error('At least one router configuration is required');
 console.log('Production configuration shape passed. Live connectivity and permissions still require staging verification.');
}catch(error){console.error('Production configuration rejected. Check required HTTPS origins, Supabase keys and unique router scopes.');process.exit(1);}
