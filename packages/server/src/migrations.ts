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
  {
    id: 5,
    sql: `
create table plugins (
  id text primary key,
  enabled integer not null default 1,
  installed_at integer not null
);
`,
  },
  {
    id: 6,
    sql: `
create table voice_people (
  id integer primary key autoincrement,
  name text not null unique collate nocase,
  centroid_enc blob not null,
  dim integer not null,
  samples integer not null,
  model text not null,
  created_at integer not null
);
`,
  },
  {
    id: 7,
    sql: `
create table widgets (
  id text primary key,
  object_json text not null,
  position integer not null
);
`,
  },
  {
    id: 8,
    sql: `
create table media (
  id text primary key,
  path text not null,
  mime text not null,
  size integer not null,
  created_at integer not null
);
`,
  },
  {
    id: 9,
    sql: `
create table channel_messages (
  id integer primary key autoincrement,
  channel text not null,
  direction text not null,
  peer text not null,
  name text not null default '',
  text text not null,
  ts integer not null,
  read integer not null default 0
);
create index channel_messages_ts on channel_messages (ts);
`,
  },
  {
    id: 10,
    sql: `
create table report_schedules (
  id integer primary key autoincrement,
  name text not null,
  broker text not null,
  kind text not null,
  time text not null,
  days text not null,
  channel text not null,
  commentary integer not null default 0,
  enabled integer not null default 1,
  last_run_day text,
  attempt_day text,
  attempts integer not null default 0
);
`,
  },
  {
    id: 11,
    sql: `
create table usage (
  id integer primary key autoincrement,
  at integer not null,
  day text not null,
  provider text not null,
  model text not null,
  source text not null,
  input integer not null,
  output integer not null
);
create index usage_day on usage (day);
`,
  },
];
