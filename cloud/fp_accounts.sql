-- Fifteen Press accounts (puzzle game). Self-contained: fp_ tables and fp_ functions only.
-- Clients never touch the tables. RLS is on with no policies, and every call goes through
-- a security definer function that checks a session token.

create table if not exists public.fp_accounts (
  id uuid primary key default gen_random_uuid(),
  handle text not null unique check (handle ~ '^[a-z0-9_]{3,20}$'),
  name text not null check (char_length(name) between 1 and 24),
  pass_hash text not null,
  settings jsonb,
  summary jsonb,
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now()
);

create table if not exists public.fp_sessions (
  token_hash text primary key,
  account_id uuid not null references public.fp_accounts (id) on delete cascade,
  created_at timestamptz not null default now(),
  last_used timestamptz not null default now()
);
create index if not exists fp_sessions_account_idx on public.fp_sessions (account_id);

create table if not exists public.fp_solves (
  account_id uuid not null references public.fp_accounts (id) on delete cascade,
  id text not null check (char_length(id) between 1 and 40),
  n smallint not null check (n between 2 and 12),
  mode text,
  duration integer not null check (duration >= 0),
  move_count integer not null check (move_count >= 0),
  optimal integer,
  solved_at timestamptz not null,
  clean boolean not null default false,
  daily text,
  deleted boolean not null default false,
  data jsonb,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (account_id, id)
);
create index if not exists fp_solves_sync_idx on public.fp_solves (account_id, updated_at, id);
create index if not exists fp_solves_board_idx on public.fp_solves (n, duration) where clean and not deleted;

create table if not exists public.fp_login_attempts (
  handle text not null,
  at timestamptz not null default now()
);
create index if not exists fp_login_attempts_idx on public.fp_login_attempts (handle, at);

alter table public.fp_accounts enable row level security;
alter table public.fp_sessions enable row level security;
alter table public.fp_solves enable row level security;
alter table public.fp_login_attempts enable row level security;
revoke all on public.fp_accounts, public.fp_sessions, public.fp_solves, public.fp_login_attempts from anon, authenticated;

comment on table public.fp_accounts is 'Fifteen Press puzzle accounts. No client access; fp_* RPCs only.';
comment on table public.fp_sessions is 'Fifteen Press login sessions (token hashes). No client access.';
comment on table public.fp_solves is 'Fifteen Press solve history per account. No client access; fp_* RPCs only.';
comment on table public.fp_login_attempts is 'Fifteen Press failed-login throttle. No client access.';

-- ---------- helpers (not callable by clients) ----------

create or replace function public._fp_new_session(p_account uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  insert into public.fp_sessions (token_hash, account_id)
  values (encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), p_account);
  return v_token;
end $$;

create or replace function public._fp_auth(p_token text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_hash text;
  v_account uuid;
  v_used timestamptz;
begin
  if p_token is null or char_length(p_token) <> 64 then return null; end if;
  v_hash := encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  select account_id, last_used into v_account, v_used from public.fp_sessions where token_hash = v_hash;
  if v_account is null then return null; end if;
  if v_used < now() - interval '1 hour' then
    update public.fp_sessions set last_used = now() where token_hash = v_hash;
    update public.fp_accounts set last_seen = now() where id = v_account;
  end if;
  return v_account;
end $$;

create or replace function public._fp_profile(p_account uuid)
returns jsonb language sql security definer set search_path = '' stable as $$
  select jsonb_build_object(
    'account_id', a.id, 'handle', a.handle, 'name', a.name,
    'settings', a.settings, 'created', (extract(epoch from a.created_at) * 1000)::bigint,
    'solves', (select count(*) from public.fp_solves s where s.account_id = a.id and not s.deleted))
  from public.fp_accounts a where a.id = p_account
$$;

-- ---------- sign up, sign in, sign out ----------

create or replace function public.fp_signup(p_handle text, p_password text, p_name text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_handle text := lower(btrim(coalesce(p_handle, '')));
  v_name text := left(btrim(coalesce(nullif(btrim(p_name), ''), p_handle, '')), 24);
  v_id uuid;
begin
  if v_handle !~ '^[a-z0-9_]{3,20}$' then return jsonb_build_object('error', 'bad_handle'); end if;
  if p_password is null or char_length(p_password) < 6 or char_length(p_password) > 72 then
    return jsonb_build_object('error', 'bad_password');
  end if;
  if (select count(*) from public.fp_accounts where created_at > now() - interval '1 hour') >= 40 then
    return jsonb_build_object('error', 'busy');
  end if;
  begin
    insert into public.fp_accounts (handle, name, pass_hash)
    values (v_handle, v_name, extensions.crypt(p_password, extensions.gen_salt('bf', 10)))
    returning id into v_id;
  exception when unique_violation then
    return jsonb_build_object('error', 'handle_taken');
  end;
  return jsonb_build_object('ok', true, 'token', public._fp_new_session(v_id)) || public._fp_profile(v_id);
end $$;

create or replace function public.fp_login(p_handle text, p_password text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_handle text := lower(btrim(coalesce(p_handle, '')));
  v_id uuid;
  v_hash text;
begin
  delete from public.fp_login_attempts where at < now() - interval '1 day';
  if (select count(*) from public.fp_login_attempts where handle = v_handle and at > now() - interval '10 minutes') >= 8 then
    return jsonb_build_object('error', 'too_many_attempts');
  end if;
  select id, pass_hash into v_id, v_hash from public.fp_accounts where handle = v_handle;
  if v_id is null or p_password is null or v_hash <> extensions.crypt(left(p_password, 72), v_hash) then
    insert into public.fp_login_attempts (handle) values (v_handle);
    return jsonb_build_object('error', 'bad_login');
  end if;
  delete from public.fp_login_attempts where handle = v_handle;
  delete from public.fp_sessions where account_id = v_id and last_used < now() - interval '180 days';
  update public.fp_accounts set last_seen = now() where id = v_id;
  return jsonb_build_object('ok', true, 'token', public._fp_new_session(v_id)) || public._fp_profile(v_id);
end $$;

create or replace function public.fp_logout(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if p_token is not null then
    delete from public.fp_sessions where token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.fp_whoami(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid := public._fp_auth(p_token);
begin
  if v_id is null then return jsonb_build_object('error', 'bad_session'); end if;
  return jsonb_build_object('ok', true) || public._fp_profile(v_id);
end $$;

-- ---------- profile ----------

create or replace function public.fp_profile_update(p_token text, p_name text default null, p_settings jsonb default null, p_summary jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid := public._fp_auth(p_token);
begin
  if v_id is null then return jsonb_build_object('error', 'bad_session'); end if;
  if p_settings is not null and pg_column_size(p_settings) > 16384 then return jsonb_build_object('error', 'too_big'); end if;
  if p_summary is not null and pg_column_size(p_summary) > 16384 then return jsonb_build_object('error', 'too_big'); end if;
  update public.fp_accounts set
    name = coalesce(nullif(left(btrim(p_name), 24), ''), name),
    settings = coalesce(p_settings, settings),
    summary = coalesce(p_summary, summary)
  where id = v_id;
  return jsonb_build_object('ok', true) || public._fp_profile(v_id);
end $$;

create or replace function public.fp_change_password(p_token text, p_old text, p_new text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := public._fp_auth(p_token);
  v_hash text;
begin
  if v_id is null then return jsonb_build_object('error', 'bad_session'); end if;
  if p_new is null or char_length(p_new) < 6 or char_length(p_new) > 72 then
    return jsonb_build_object('error', 'bad_password');
  end if;
  select pass_hash into v_hash from public.fp_accounts where id = v_id;
  if p_old is null or v_hash <> extensions.crypt(left(p_old, 72), v_hash) then
    return jsonb_build_object('error', 'bad_login');
  end if;
  update public.fp_accounts set pass_hash = extensions.crypt(p_new, extensions.gen_salt('bf', 10)) where id = v_id;
  delete from public.fp_sessions
  where account_id = v_id and token_hash <> encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.fp_delete_account(p_token text, p_password text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := public._fp_auth(p_token);
  v_hash text;
begin
  if v_id is null then return jsonb_build_object('error', 'bad_session'); end if;
  select pass_hash into v_hash from public.fp_accounts where id = v_id;
  if p_password is null or v_hash <> extensions.crypt(left(p_password, 72), v_hash) then
    return jsonb_build_object('error', 'bad_login');
  end if;
  delete from public.fp_accounts where id = v_id;
  return jsonb_build_object('ok', true);
end $$;

-- ---------- solves: push and pull ----------

create or replace function public.fp_push(p_token text, p_solves jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := public._fp_auth(p_token);
  v_item jsonb;
  v_saved integer := 0;
  v_skipped integer := 0;
  v_count integer;
begin
  if v_id is null then return jsonb_build_object('error', 'bad_session'); end if;
  if p_solves is null or jsonb_typeof(p_solves) <> 'array' or jsonb_array_length(p_solves) > 200 then
    return jsonb_build_object('error', 'bad_request');
  end if;
  select count(*) into v_count from public.fp_solves where account_id = v_id;
  for v_item in select * from jsonb_array_elements(p_solves) loop
    begin
      if v_count >= 50000 and not exists (
        select 1 from public.fp_solves where account_id = v_id and id = v_item->>'id') then
        v_skipped := v_skipped + 1;
        continue;
      end if;
      if pg_column_size(v_item) > 120000 then
        v_skipped := v_skipped + 1;
        continue;
      end if;
      insert into public.fp_solves as s
        (account_id, id, n, mode, duration, move_count, optimal, solved_at, clean, daily, deleted, data, updated_at)
      values (
        v_id,
        v_item->>'id',
        (v_item->>'N')::smallint,
        left(v_item->>'mode', 12),
        (v_item->>'duration')::integer,
        (v_item->>'moveCount')::integer,
        nullif(v_item->>'optimal', '')::integer,
        to_timestamp(((v_item->>'date')::double precision) / 1000.0),
        coalesce((v_item->>'clean')::boolean, false),
        left(v_item->>'daily', 12),
        coalesce((v_item->>'deleted')::boolean, false),
        case when coalesce((v_item->>'deleted')::boolean, false) then null else v_item->'data' end,
        clock_timestamp())
      on conflict (account_id, id) do update set
        n = excluded.n, mode = excluded.mode, duration = excluded.duration,
        move_count = excluded.move_count, optimal = excluded.optimal, solved_at = excluded.solved_at,
        clean = excluded.clean, daily = excluded.daily, deleted = excluded.deleted,
        data = excluded.data, updated_at = clock_timestamp();
      v_saved := v_saved + 1;
      v_count := v_count + 1;
    exception when others then
      v_skipped := v_skipped + 1;
    end;
  end loop;
  return jsonb_build_object('ok', true, 'saved', v_saved, 'skipped', v_skipped);
end $$;

create or replace function public.fp_pull(p_token text, p_since timestamptz default null, p_after text default '', p_limit integer default 300)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid := public._fp_auth(p_token);
  v_limit integer := least(greatest(coalesce(p_limit, 300), 1), 500);
  v_rows jsonb;
  v_n integer;
begin
  if v_id is null then return jsonb_build_object('error', 'bad_session'); end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', q.id, 'deleted', q.deleted, 'data', q.data, 't', q.updated_at) order by q.updated_at, q.id), '[]'::jsonb),
    count(*)
  into v_rows, v_n
  from (
    select s.id, s.deleted, s.data, s.updated_at
    from public.fp_solves s
    where s.account_id = v_id
      and (p_since is null or (s.updated_at, s.id) > (p_since, coalesce(p_after, '')))
    order by s.updated_at, s.id
    limit v_limit
  ) q;
  return jsonb_build_object('ok', true, 'solves', v_rows, 'more', v_n = v_limit);
end $$;

-- ---------- leaderboard ----------

-- p_cat: time | moves | tps | daily | count | ao5 | ao12
create or replace function public.fp_leaderboard(p_n integer, p_cat text default 'time', p_daily text default null)
returns jsonb language plpgsql security definer set search_path = '' stable as $$
declare v_rows jsonb;
begin
  if p_cat in ('ao5', 'ao12') then
    select coalesce(jsonb_agg(r order by (r->>'value')::numeric), '[]'::jsonb) into v_rows from (
      select jsonb_build_object('handle', a.handle, 'name', a.name,
        'value', (a.summary -> p_n::text ->> p_cat)::numeric) as r
      from public.fp_accounts a
      where (a.summary -> p_n::text ->> p_cat) ~ '^[0-9]+(\.[0-9]+)?$'
      order by (a.summary -> p_n::text ->> p_cat)::numeric
      limit 100) t;
  elsif p_cat = 'count' then
    select coalesce(jsonb_agg(r order by (r->>'value')::numeric desc), '[]'::jsonb) into v_rows from (
      select jsonb_build_object('handle', a.handle, 'name', a.name, 'value', count(*)) as r
      from public.fp_solves s join public.fp_accounts a on a.id = s.account_id
      where s.n = p_n and s.clean and not s.deleted
      group by a.id order by count(*) desc limit 100) t;
  else
    select coalesce(jsonb_agg(r order by ord), '[]'::jsonb) into v_rows from (
      select jsonb_build_object('handle', b.handle, 'name', b.name, 'time', b.duration, 'moves', b.move_count,
          'optimal', b.optimal, 'at', (extract(epoch from b.solved_at) * 1000)::bigint) as r,
        row_number() over (order by b.key, b.duration) as ord
      from (
        select distinct on (s.account_id) a.handle, a.name, s.duration, s.move_count, s.optimal, s.solved_at,
          case p_cat
            when 'moves' then s.move_count::numeric
            when 'tps' then -(s.move_count::numeric * 1000 / greatest(s.duration, 1))
            else s.duration::numeric end as key
        from public.fp_solves s join public.fp_accounts a on a.id = s.account_id
        where s.n = p_n and s.clean and not s.deleted and s.duration >= 200 and s.move_count > 0
          and (p_cat <> 'daily' or s.daily = p_daily)
        order by s.account_id,
          case p_cat
            when 'moves' then s.move_count::numeric
            when 'tps' then -(s.move_count::numeric * 1000 / greatest(s.duration, 1))
            else s.duration::numeric end,
          s.duration
      ) b
      order by b.key, b.duration
      limit 100) t;
  end if;
  return jsonb_build_object('ok', true, 'rows', v_rows);
end $$;

-- ---------- who may call what ----------

revoke all on function public._fp_new_session(uuid) from public, anon, authenticated;
revoke all on function public._fp_auth(text) from public, anon, authenticated;
revoke all on function public._fp_profile(uuid) from public, anon, authenticated;

revoke all on function public.fp_signup(text, text, text) from public;
revoke all on function public.fp_login(text, text) from public;
revoke all on function public.fp_logout(text) from public;
revoke all on function public.fp_whoami(text) from public;
revoke all on function public.fp_profile_update(text, text, jsonb, jsonb) from public;
revoke all on function public.fp_change_password(text, text, text) from public;
revoke all on function public.fp_delete_account(text, text) from public;
revoke all on function public.fp_push(text, jsonb) from public;
revoke all on function public.fp_pull(text, timestamptz, text, integer) from public;
revoke all on function public.fp_leaderboard(integer, text, text) from public;

grant execute on function public.fp_signup(text, text, text) to anon, authenticated;
grant execute on function public.fp_login(text, text) to anon, authenticated;
grant execute on function public.fp_logout(text) to anon, authenticated;
grant execute on function public.fp_whoami(text) to anon, authenticated;
grant execute on function public.fp_profile_update(text, text, jsonb, jsonb) to anon, authenticated;
grant execute on function public.fp_change_password(text, text, text) to anon, authenticated;
grant execute on function public.fp_delete_account(text, text) to anon, authenticated;
grant execute on function public.fp_push(text, jsonb) to anon, authenticated;
grant execute on function public.fp_pull(text, timestamptz, text, integer) to anon, authenticated;
grant execute on function public.fp_leaderboard(integer, text, text) to anon, authenticated;
