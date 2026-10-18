-- Replix social backend for Supabase.
-- Paste this whole file into Supabase → SQL Editor → New query → Run. Safe to run again.

-- ============ tables ============
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  username text unique not null check (username ~ '^[A-Za-z0-9_]{3,20}$'),
  display_name text check (char_length(display_name) <= 40),
  bio text check (char_length(bio) <= 160),
  avatar_url text,
  created_at timestamptz not null default now()
);

create table if not exists public.games (
  id text primary key,                 -- slug, e.g. 'fortnite'
  name text not null unique,
  color text not null default '#00e5ff'
);

create table if not exists public.game_follows (
  user_id uuid references public.profiles on delete cascade,
  game_id text references public.games on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, game_id)
);

create table if not exists public.follows (
  follower_id uuid references public.profiles on delete cascade,
  following_id uuid references public.profiles on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, following_id),
  check (follower_id <> following_id)
);

create table if not exists public.posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade,
  game_id text references public.games on delete set null,
  title text not null check (char_length(title) between 1 and 100),
  video_path text not null,            -- path inside the 'clips' storage bucket
  thumb_path text,
  duration real,
  size_bytes bigint,
  created_at timestamptz not null default now()
);
create index if not exists posts_created_idx on public.posts (created_at desc);
create index if not exists posts_game_idx on public.posts (game_id, created_at desc);
create index if not exists posts_user_idx on public.posts (user_id, created_at desc);

create table if not exists public.likes (
  user_id uuid references public.profiles on delete cascade,
  post_id uuid references public.posts on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, post_id)
);

create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.posts on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,
  body text not null check (char_length(body) between 1 and 500),
  created_at timestamptz not null default now()
);
create index if not exists comments_post_idx on public.comments (post_id, created_at);

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles on delete cascade,
  post_id uuid references public.posts on delete cascade,
  comment_id uuid references public.comments on delete cascade,
  reason text not null check (char_length(reason) <= 300),
  created_at timestamptz not null default now()
);

-- Feed view: posts with author, game and counts in one query.
create or replace view public.post_feed with (security_invoker = true) as
  select p.*, pr.username, pr.display_name, pr.avatar_url,
         g.name as game_name, g.color as game_color,
         (select count(*) from public.likes l where l.post_id = p.id) as like_count,
         (select count(*) from public.comments c where c.post_id = p.id) as comment_count
  from public.posts p
  join public.profiles pr on pr.id = p.user_id
  left join public.games g on g.id = p.game_id;

-- Profile stats.
create or replace view public.profile_stats with (security_invoker = true) as
  select pr.id,
         (select count(*) from public.follows f where f.following_id = pr.id) as followers,
         (select count(*) from public.follows f where f.follower_id = pr.id) as following,
         (select count(*) from public.posts p where p.user_id = pr.id) as posts
  from public.profiles pr;

-- New sign-ups get a profile row from the username they chose.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username, display_name)
  values (new.id, new.raw_user_meta_data->>'username', coalesce(new.raw_user_meta_data->>'username', 'player'));
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Let the sign-up form check whether a username is free.
create or replace function public.username_available(name text) returns boolean
language sql security definer set search_path = public stable as $$
  select not exists (select 1 from public.profiles where lower(username) = lower(name));
$$;

-- ============ row level security ============
-- Everyone (signed in or not) can read; people can only change their own rows.
alter table public.profiles enable row level security;
alter table public.games enable row level security;
alter table public.game_follows enable row level security;
alter table public.follows enable row level security;
alter table public.posts enable row level security;
alter table public.likes enable row level security;
alter table public.comments enable row level security;
alter table public.reports enable row level security;

do $$ begin
  drop policy if exists "read profiles" on public.profiles;
  drop policy if exists "update own profile" on public.profiles;
  drop policy if exists "read games" on public.games;
  drop policy if exists "read game follows" on public.game_follows;
  drop policy if exists "own game follows" on public.game_follows;
  drop policy if exists "delete own game follows" on public.game_follows;
  drop policy if exists "read follows" on public.follows;
  drop policy if exists "own follows" on public.follows;
  drop policy if exists "delete own follows" on public.follows;
  drop policy if exists "read posts" on public.posts;
  drop policy if exists "create own posts" on public.posts;
  drop policy if exists "edit own posts" on public.posts;
  drop policy if exists "delete own posts" on public.posts;
  drop policy if exists "read likes" on public.likes;
  drop policy if exists "own likes" on public.likes;
  drop policy if exists "delete own likes" on public.likes;
  drop policy if exists "read comments" on public.comments;
  drop policy if exists "create own comments" on public.comments;
  drop policy if exists "delete own comments" on public.comments;
  drop policy if exists "create reports" on public.reports;
end $$;

create policy "read profiles" on public.profiles for select using (true);
create policy "update own profile" on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);
create policy "read games" on public.games for select using (true);
create policy "read game follows" on public.game_follows for select using (true);
create policy "own game follows" on public.game_follows for insert with check (auth.uid() = user_id);
create policy "delete own game follows" on public.game_follows for delete using (auth.uid() = user_id);
create policy "read follows" on public.follows for select using (true);
create policy "own follows" on public.follows for insert with check (auth.uid() = follower_id);
create policy "delete own follows" on public.follows for delete using (auth.uid() = follower_id);
create policy "read posts" on public.posts for select using (true);
create policy "create own posts" on public.posts for insert with check (auth.uid() = user_id);
create policy "edit own posts" on public.posts for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "delete own posts" on public.posts for delete using (auth.uid() = user_id);
create policy "read likes" on public.likes for select using (true);
create policy "own likes" on public.likes for insert with check (auth.uid() = user_id);
create policy "delete own likes" on public.likes for delete using (auth.uid() = user_id);
create policy "read comments" on public.comments for select using (true);
create policy "create own comments" on public.comments for insert with check (auth.uid() = user_id);
create policy "delete own comments" on public.comments for delete using (auth.uid() = user_id);
create policy "create reports" on public.reports for insert with check (auth.uid() = reporter_id);
-- (reports are only readable from the Supabase dashboard)

-- ============ storage ============
-- 'clips' bucket: public to watch, max 50 MB per file, people upload only into their own folder (<user id>/...).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('clips', 'clips', true, 52428800, array['video/mp4', 'image/jpeg', 'image/png', 'image/gif'])
on conflict (id) do update set public = true, file_size_limit = 52428800, allowed_mime_types = excluded.allowed_mime_types;

do $$ begin
  drop policy if exists "clips public read" on storage.objects;
  drop policy if exists "clips upload own folder" on storage.objects;
  drop policy if exists "clips delete own" on storage.objects;
end $$;
create policy "clips public read" on storage.objects for select using (bucket_id = 'clips');
create policy "clips upload own folder" on storage.objects for insert to authenticated
  with check (bucket_id = 'clips' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "clips delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'clips' and (storage.foldername(name))[1] = auth.uid()::text);

-- ============ game catalog ============
insert into public.games (id, name, color) values
  ('fortnite', 'Fortnite', '#9d4dff'), ('valorant', 'Valorant', '#ff4655'), ('cs2', 'Counter-Strike 2', '#f5a623'),
  ('roblox', 'Roblox', '#e2231a'), ('gta-v', 'GTA V', '#5fb648'), ('call-of-duty', 'Call of Duty', '#ff7a00'),
  ('apex-legends', 'Apex Legends', '#da292a'), ('overwatch-2', 'Overwatch 2', '#f99e1a'), ('rocket-league', 'Rocket League', '#0090ff'),
  ('league-of-legends', 'League of Legends', '#c89b3c'), ('minecraft', 'Minecraft', '#62b47a'), ('rainbow-six-siege', 'Rainbow Six Siege', '#4a90d9'),
  ('marvel-rivals', 'Marvel Rivals', '#ed1d24'), ('skate', 'skate.', '#ffd400'), ('ea-sports-fc', 'EA Sports FC', '#00ff87'),
  ('the-finals', 'The Finals', '#d31f3c'), ('pubg', 'PUBG', '#f2a900'), ('rust', 'Rust', '#ce422b'),
  ('dota-2', 'Dota 2', '#a72714'), ('destiny-2', 'Destiny 2', '#8fa3b8'), ('deadlock', 'Deadlock', '#c7a46b'),
  ('elden-ring', 'Elden Ring', '#b59a5b'), ('fivem', 'FiveM', '#f40552'), ('other', 'Other', '#8b8b98')
on conflict (id) do update set name = excluded.name, color = excluded.color;
