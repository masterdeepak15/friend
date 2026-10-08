export const MIGRATIONS: { id: number; sql: string }[] = [
  {
    id: 1,
    sql: `
create table owner (
  id integer primary key check (id = 1),
  password_hash text not null,
  pin_hash text not null,
  assistant_name text not null,
  created_at integer not null
);
create table sessions (
  id integer primary key autoincrement,
  token_hash text not null unique,
  kind text not null,
  expires_at integer not null,
  ip text,
  ua text,
  revoked integer not null default 0
);
create table devices (
  id integer primary key autoincrement,
  name text not null,
  token_hash text not null unique,
  last_seen integer,
  config_json text not null default '{}'
);
create table pair_codes (
  code_hash text primary key,
  expires_at integer not null
);
create table messages (
  id integer primary key autoincrement,
  role text not null,
  content_json text not null,
  created_at integer not null
);
create table rules (
  id integer primary key autoincrement,
  tool text not null,
  matcher_json text not null,
  created_at integer not null
);
create table approvals (
  id text primary key,
  tool text not null,
  summary text not null,
  tier text not null,
  decision text,
  decided_at integer
);
create table audit_log (
  id integer primary key autoincrement,
  ts integer not null,
  actor text not null,
  kind text not null,
  detail_json text not null
);
`,
  },
  {
    id: 2,
    sql: `
create table voiceprint (
  id integer primary key check (id = 1),
  centroid_enc blob not null,
  dim integer not null,
  samples integer not null,
  model text not null,
  created_at integer not null
);
`,
  },
  {
    id: 3,
    sql: `
create table memories (
  id integer primary key autoincrement,
  text text not null,
  source text not null check (source in ('owner', 'agent')),
  created_at integer not null
);
`,
  },
  {
    id: 4,
    sql: `
create table tasks (
  id integer primary key autoincrement,
  title text not null,
  due_at integer,
  repeat text check (repeat in ('hourly', 'daily', 'weekly')),
  status text not null default 'open' check (status in ('open', 'done')),
  created_at integer not null,
  fired_at integer
);
create index tasks_due on tasks (status, due_at);
`,
  },
];
