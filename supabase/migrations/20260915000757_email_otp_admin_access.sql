create or replace function app_private.has_access(org uuid, roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    where m.user_id = (select auth.uid())
      and m.organization_id = org
      and m.status = 'active'
      and m.role = any(roles)
  );
$$;

revoke all on function app_private.has_access(uuid, text[]) from public;
grant execute on function app_private.has_access(uuid, text[]) to authenticated;
