begin;

-- Existing Silang subscribers, staff, plans and ledger rows remain attached to
-- the same organization row, which becomes the Bayan coverage. Silang Old is
-- introduced as a new isolated tenant for newly assigned staff/subscribers.
do $migration$
declare
  bayan_id uuid;
begin
  select id into bayan_id
  from public.organizations
  where lower(name) in ('southwoods silang', 'southwoods silang bayan')
  order by created_at, id
  limit 1;

  if bayan_id is null then
    insert into public.organizations(
      name, currency, timezone, address, contact_email, contact_phone
    ) values (
      'Southwoods Silang Bayan', 'PHP', 'Asia/Manila',
      'Silang Bayan, Cavite, Philippines', 'silang.bayan@southwoods.example', ''
    ) returning id into bayan_id;
  else
    update public.organizations
    set name = 'Southwoods Silang Bayan',
        address = case when address = '' then 'Silang Bayan, Cavite, Philippines' else address end,
        contact_email = case when contact_email in ('', 'silang@southwoods.example')
          then 'silang.bayan@southwoods.example' else contact_email end
    where id = bayan_id;
  end if;

  if not exists (
    select 1 from public.organizations where lower(name) = 'southwoods silang old'
  ) then
    insert into public.organizations(
      name, currency, timezone, address, contact_email, contact_phone
    ) values (
      'Southwoods Silang Old', 'PHP', 'Asia/Manila',
      'Silang Old, Cavite, Philippines', 'silang.old@southwoods.example', ''
    );
  end if;
end;
$migration$;

commit;
