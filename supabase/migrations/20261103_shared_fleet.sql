create table public.fleet_state (
 id integer primary key check(id=1), revision bigint not null default 0,
 payload jsonb not null, updated_at timestamptz not null default now()
);
alter table public.fleet_state enable row level security;
revoke all on public.fleet_state from anon, authenticated;
create table public.fleet_revisions (
 revision bigint primary key, payload jsonb not null, created_at timestamptz not null default now()
);
alter table public.fleet_revisions enable row level security;
revoke all on public.fleet_revisions from anon, authenticated;
create function public.fleet_commit(expected_revision bigint, next_payload jsonb)
returns bigint language plpgsql security invoker set search_path=public as $$
declare old public.fleet_state; next_revision bigint;
begin
 select * into old from public.fleet_state where id=1 for update;
 if old.revision is distinct from expected_revision then
  raise exception 'Fleet records changed. Refresh and retry.' using errcode='40001';
 end if;
 insert into public.fleet_revisions(revision,payload) values(old.revision,old.payload) on conflict do nothing;
 next_revision=old.revision+1;
 update public.fleet_state set payload=next_payload,revision=next_revision,updated_at=now() where id=1;
 delete from public.fleet_revisions where revision < next_revision-30;
 return next_revision;
end $$;
revoke all on function public.fleet_commit(bigint,jsonb) from public,anon,authenticated;
grant execute on function public.fleet_commit(bigint,jsonb) to service_role;
insert into storage.buckets(id,name,public,file_size_limit) values('fleet-files','fleet-files',false,31457280) on conflict do nothing;
