-- Replix update 2: game artwork + profile customization. Safe to run again.

-- Game artwork (official Steam store header images; non-Steam games keep their color icon).
alter table public.games add column if not exists image_url text;

update public.games g set image_url = v.url from (values
  ('cs2', 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/730/162664aa5da85f418105350c5d67ca565f6c3713/header.jpg'),
  ('gta-v', 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/271590/header.jpg'),
  ('call-of-duty', 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1938090/23af6cf41e2d09620caa07700a4cb3288dbcbaa8/header.jpg'),
  ('apex-legends', 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1172470/6cf04767652d703b6050da84b82cfb1194258d7d/header.jpg'),
  ('overwatch-2', 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2357570/5c208b2699cd38ed6125d039be388fa744db54a4/header_alt_assets_23.jpg'),
  ('rocket-league', 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/252950/3abd9ab079c8896a4762dbe34a853d89b7f704df/header_alt_assets_17.jpg'),
  ('rainbow-six-siege', 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/359550/555b5051d332c5f6b86f88ba5dfd80404dc91aaa/header_alt_assets_27.jpg'),
  ('marvel-rivals', 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2767030/c61f65c5968af5d85b0393005991ecee0184fcaf/header.jpg'),
  ('the-finals', 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2073850/61f55ef49a74c76bf9fda9ec35bc3101eeee2b3e/header.jpg'),
  ('pubg', 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/578080/841ea38bc58cabb70aef65365cf50bc2d79329d9/header.jpg'),
  ('rust', 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/252490/header.jpg'),
  ('dota-2', 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/570/header.jpg'),
  ('destiny-2', 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1085660/0ccf0dc0a8c4ec078db7ab99ddc820b2fa884441/header.jpg'),
  ('deadlock', 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1422450/aa249c5e8cc8f90941bd1dbdc311773cd1afe065/header.jpg'),
  ('elden-ring', 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1245620/header.jpg'),
  ('skate', 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/3354750/79c5a87b61a396cc6e6b69e3a083727f175dea83/header.jpg'),
  ('ea-sports-fc', 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/4080220/ff6a3779f1ca83aae8ad3878454f6c11008ea24d/header.jpg')
) as v(id, url) where g.id = v.id;

-- Profile customization.
alter table public.profiles add column if not exists banner_url text;
alter table public.profiles add column if not exists accent_color text;
alter table public.profiles add column if not exists links jsonb not null default '{}'::jsonb;
alter table public.profiles add column if not exists favorite_games text[] not null default '{}';
do $$ begin
  alter table public.profiles drop constraint if exists profiles_accent_hex;
  alter table public.profiles add constraint profiles_accent_hex check (accent_color is null or accent_color ~ '^#[0-9a-fA-F]{6}$');
  alter table public.profiles drop constraint if exists profiles_fav_games_max;
  alter table public.profiles add constraint profiles_fav_games_max check (cardinality(favorite_games) <= 3);
  alter table public.profiles drop constraint if exists profiles_links_size;
  alter table public.profiles add constraint profiles_links_size check (pg_column_size(links) < 2000);
end $$;

-- Feed view gains game art + author accent (new columns go at the end).
create or replace view public.post_feed with (security_invoker = true) as
  select p.*, pr.username, pr.display_name, pr.avatar_url,
         g.name as game_name, g.color as game_color,
         (select count(*) from public.likes l where l.post_id = p.id) as like_count,
         (select count(*) from public.comments c where c.post_id = p.id) as comment_count,
         g.image_url as game_image, pr.accent_color
  from public.posts p
  join public.profiles pr on pr.id = p.user_id
  left join public.games g on g.id = p.game_id;
