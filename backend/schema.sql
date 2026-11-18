create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique,
  display_name text not null default 'Guest',
  avatar text not null default 'none',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.friendships (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles(id) on delete cascade,
  addressee_id uuid not null references public.profiles(id) on delete cascade,
  pair_key text not null unique,
  status text not null check (status in ('pending','accepted','rejected','blocked')) default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (requester_id <> addressee_id)
);
create index if not exists friendships_addressee_status_idx on public.friendships(addressee_id,status);
create index if not exists friendships_requester_status_idx on public.friendships(requester_id,status);

create table if not exists public.game_rooms (
  code text primary key,
  host_user_id uuid not null references public.profiles(id),
  state jsonb not null default '{}'::jsonb,
  is_private boolean not null default false,
  status text not null check (status in ('active','closed','expired')) default 'active',
  heartbeat_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists game_rooms_host_idx on public.game_rooms(host_user_id);

alter table public.profiles enable row level security;
alter table public.friendships enable row level security;
alter table public.game_rooms enable row level security;
-- All writes/reads in the starter server use the service role only after validating the caller's Supabase JWT.
-- Do not expose SUPABASE_SERVICE_ROLE_KEY in the browser or commit .env.
