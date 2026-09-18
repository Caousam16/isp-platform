begin;

-- Preserve the existing customer base as Silang, then add Carmona as a
-- separate tenant. New installations receive both company rows.
do $migration$
declare
  silang_id uuid;
begin
  select id into silang_id
  from public.organizations
  where lower(name) = 'southwoods silang'
  limit 1;

  if silang_id is null then
    select id into silang_id
    from public.organizations
    where lower(name) in (
      'southwoods cable and internet',
      'southwoods cable & internet'
    )
    order by created_at, id
    limit 1;
  end if;

  if silang_id is null then
    insert into public.organizations(
      name, currency, timezone, address, contact_email, contact_phone
    ) values (
      'Southwoods Silang', 'PHP', 'Asia/Manila',
      'Silang, Cavite, Philippines', 'silang@southwoods.example', ''
    ) returning id into silang_id;
  else
    update public.organizations
    set name = 'Southwoods Silang'
    where id = silang_id;
  end if;

  if not exists (
    select 1 from public.organizations where lower(name) = 'southwoods carmona'
  ) then
    insert into public.organizations(
      name, currency, timezone, address, contact_email, contact_phone
    ) values (
      'Southwoods Carmona', 'PHP', 'Asia/Manila',
      'Carmona, Cavite, Philippines', 'carmona@southwoods.example', ''
    );
  end if;
end;
$migration$;

-- A subscriber signs in through the shared portal with only an account
-- number, so account numbers must be unique across both companies.
create unique index if not exists subscribers_account_number_global_key
  on public.subscribers (account_number);

-- An active admin membership is group-wide. Staff and subscriber access
-- remains tied to the organization_id on their own membership.
create or replace function app_private.has_access(org uuid, roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select
    exists (
      select 1
      from public.memberships m
      where m.user_id = (select auth.uid())
        and m.organization_id = org
        and m.status = 'active'
        and m.role = any(roles)
    )
    or (
      'admin' = any(roles)
      and exists (
        select 1
        from public.memberships administrator
        where administrator.user_id = (select auth.uid())
          and administrator.status = 'active'
          and administrator.role = 'admin'
      )
    );
$function$;

revoke all on function app_private.has_access(uuid, text[])
  from public, anon;
grant execute on function app_private.has_access(uuid, text[])
  to authenticated;

commit;
