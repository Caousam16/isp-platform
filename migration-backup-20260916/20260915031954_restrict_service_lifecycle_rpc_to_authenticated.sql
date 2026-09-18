begin;
revoke all on function public.manage_subscriber_service(uuid,text,uuid) from public, anon;
grant execute on function public.manage_subscriber_service(uuid,text,uuid) to authenticated;
commit;
