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
  {
    id: 12,
    sql: `
create table office_workers (
  id text primary key,
  name text not null,
  role_id text not null,
  project_id text not null,
  status text not null default 'idle',
  session_id text,
  ticket_id integer,
  detail text not null default '',
  tokens integer not null default 0,
  created_at integer not null,
  started_at integer
);
create table office_tickets (
  id integer primary key autoincrement,
  project_id text not null,
  title text not null,
  description text not null default '',
  status text not null default 'todo',
  worker_id text,
  created_at integer not null,
  updated_at integer not null
);
create table office_events (
  id integer primary key autoincrement,
  worker_id text not null,
  at integer not null,
  kind text not null,
  text text not null
);
create index office_events_worker on office_events (worker_id, id);
create index office_tickets_project on office_tickets (project_id);
`,
  },
  {
    id: 13,
    sql: `alter table office_tickets add column report text not null default '';`,
  },
  {
    id: 14,
    sql: `alter table office_workers add column title text not null default '';
alter table office_workers add column capabilities text not null default '';
alter table office_workers add column instructions text not null default '';
alter table office_workers add column model text not null default '';
alter table office_workers add column permission text not null default 'default';
alter table office_workers add column manager_id text;`,
  },
  {
    id: 15,
    sql: `create table office_requests (
  id integer primary key autoincrement,
  worker_id text not null,
  ticket_id integer,
  tool text not null,
  summary text not null,
  danger integer not null default 0,
  status text not null default 'pending',
  decision text,
  reason text not null default '',
  tries integer not null default 0,
  created_at integer not null,
  decided_at integer
);
create index office_requests_status on office_requests (status);`,
  },
  {
    id: 16,
    sql: `alter table audit_log add column actor_kind text not null default '';
alter table audit_log add column actor_id text not null default '';
alter table audit_log add column request_id text;
alter table audit_log add column parent_id text;
alter table audit_log add column target text not null default '';
alter table audit_log add column outcome text not null default '';
alter table audit_log add column truncated integer not null default 0;
alter table audit_log add column legacy integer not null default 0;
alter table audit_log add column prev_hash text not null default '';
alter table audit_log add column hash text not null default '';
update audit_log set legacy = 1;
create index audit_log_request on audit_log (request_id);
create index audit_log_ts on audit_log (ts);
create index audit_log_actor_kind on audit_log (actor_kind);
create index audit_log_kind on audit_log (kind);
alter table office_tickets add column request_id text;`,
  },
  {
    id: 17,
    sql: `create trigger audit_no_update before update on audit_log begin select raise(abort, 'audit_log is append-only'); end;
create trigger audit_no_delete before delete on audit_log begin select raise(abort, 'audit_log is append-only'); end;`,
  },
  {
    id: 18,
    sql: `create table people (
  id integer primary key autoincrement,
  name text not null,
  relation text not null default '',
  note text not null default '',
  created_at integer not null
);
create unique index people_name on people (lower(name));
create table person_faces (
  id integer primary key autoincrement,
  person_id integer not null references people (id) on delete cascade,
  vec text not null,
  created_at integer not null
);
create index person_faces_person on person_faces (person_id);`,
  },
  {
    id: 19,
    sql: `alter table office_workers add column skills text not null default '[]';
alter table office_workers add column mcp text not null default '[]';`,
  },
  {
    id: 20,
    sql: `alter table office_tickets add column assigned_by text;`,
  },
  {
    id: 21,
    sql: `alter table people add column share text not null default '';`,
  },
  {
    id: 22,
    sql: `create table decks (
  id text primary key,
  deck_json text not null,
  created_at integer not null
);`,
  },
  {
    id: 23,
    sql: `create table pcs (
  id integer primary key autoincrement,
  name text not null unique collate nocase,
  os text not null default '',
  host text not null default '',
  perms_json text not null,
  status_json text not null default '',
  created_at integer not null,
  last_seen integer not null default 0,
  revoked integer not null default 0
);
create table pc_enroll (
  id text primary key,
  pc_id integer not null references pcs (id) on delete cascade,
  user_code text unique,
  device_hash text unique,
  challenge text,
  expires_at integer not null,
  approved integer not null default 0,
  used integer not null default 0,
  os text,
  host text,
  created_at integer not null
);
create table pc_tokens (
  id integer primary key autoincrement,
  pc_id integer not null references pcs (id) on delete cascade,
  access_hash text not null unique,
  access_expires integer not null,
  refresh_hash text not null unique,
  previous_refresh_hash text,
  created_at integer not null
);
create index pc_tokens_previous on pc_tokens (previous_refresh_hash);`,
  },
  {
    id: 24,
    sql: `create table mail_accounts (
  id integer primary key autoincrement,
  name text not null unique collate nocase,
  address text not null,
  imap_host text not null,
  imap_port integer not null,
  imap_tls integer not null default 1,
  smtp_host text not null,
  smtp_port integer not null,
  smtp_secure integer not null default 1,
  username text not null,
  owners_json text not null default '[]',
  systems_json text not null default '[]',
  ladder_json text not null default '{}',
  enabled integer not null default 1,
  status text not null default 'new',
  status_detail text not null default '',
  cursor_json text not null default '',
  created_at integer not null
);
create table mail_messages (
  id integer primary key autoincrement,
  account_id integer not null references mail_accounts (id) on delete cascade,
  provider_id text not null,
  thread_id text not null,
  from_addr text not null,
  from_name text not null default '',
  to_json text not null,
  cc_json text not null default '[]',
  subject text not null,
  date integer not null,
  body text not null,
  headers_json text not null default '{}',
  attachments_json text not null default '[]',
  class text not null,
  read integer not null default 0,
  archived integer not null default 0,
  unique (account_id, provider_id)
);
create index mail_messages_account on mail_messages (account_id, id);
create table mail_events (
  id integer primary key autoincrement,
  account_id integer not null references mail_accounts (id) on delete cascade,
  kind text not null,
  provider_id text not null,
  status text not null default 'pending',
  attempts integer not null default 0,
  next_at integer not null default 0,
  last_error text not null default '',
  created_at integer not null,
  unique (account_id, kind, provider_id)
);
create table mail_sends (
  id integer primary key autoincrement,
  account_id integer not null references mail_accounts (id) on delete cascade,
  to_json text not null,
  subject text not null,
  kind text not null,
  approver text not null,
  result text not null,
  created_at integer not null
);
create index mail_sends_account on mail_sends (account_id, created_at);
create table mail_drafts (
  id integer primary key autoincrement,
  account_id integer not null references mail_accounts (id) on delete cascade,
  to_json text not null,
  subject text not null,
  body text not null,
  in_reply_to text not null default '',
  created_at integer not null
);`,
  },
  {
    id: 25,
    sql: `create table mail_templates (
  id integer primary key autoincrement,
  name text not null unique collate nocase,
  subject text not null,
  body text not null,
  created_at integer not null
);
create table mail_roles (
  id integer primary key autoincrement,
  account_id integer not null references mail_accounts (id) on delete cascade,
  name text not null unique collate nocase,
  guidelines text not null,
  auto_answer integer not null default 0,
  enabled integer not null default 1,
  created_at integer not null
);
create table mail_rules (
  id integer primary key autoincrement,
  account_id integer not null references mail_accounts (id) on delete cascade,
  name text not null,
  conditions_json text not null,
  action text not null,
  role_id integer references mail_roles (id) on delete cascade,
  enabled integer not null default 1,
  created_at integer not null
);
create table mail_cases (
  id integer primary key autoincrement,
  account_id integer not null references mail_accounts (id) on delete cascade,
  role_id integer references mail_roles (id) on delete set null,
  thread_id text not null,
  subject text not null,
  from_addr text not null,
  status text not null default 'open',
  note text not null default '',
  last_mail_id text not null default '',
  created_at integer not null,
  updated_at integer not null,
  unique (account_id, thread_id)
);
create table mail_schedules (
  id integer primary key autoincrement,
  name text not null unique collate nocase,
  kind text not null,
  at text not null default '',
  minutes integer not null default 0,
  instruction text not null,
  enabled integer not null default 1,
  last_run integer not null default 0,
  created_at integer not null
);
create table mail_watches (
  id integer primary key autoincrement,
  name text not null unique collate nocase,
  kind text not null,
  target text not null,
  interval_sec integer not null,
  expect_text text not null default '',
  instruction text not null,
  state text not null default 'unknown',
  fails integer not null default 0,
  last_check integer not null default 0,
  last_change integer not null default 0,
  detail text not null default '',
  enabled integer not null default 1,
  created_at integer not null
);`,
  },
  {
    id: 26,
    sql: `create table meetings (
  id integer primary key autoincrement,
  url text not null,
  title text not null default '',
  join_name text not null default '',
  status text not null default 'scheduled',
  detail text not null default '',
  starts_at integer not null default 0,
  started_at integer not null default 0,
  ended_at integer not null default 0,
  summary text not null default '',
  decisions text not null default '[]',
  tasks text not null default '[]',
  created_at integer not null
);
create table meeting_lines (
  id integer primary key autoincrement,
  meeting_id integer not null references meetings (id) on delete cascade,
  at integer not null,
  speaker text not null,
  text text not null
);
create index meeting_lines_meeting on meeting_lines (meeting_id, id);
create table meeting_prefs (
  key text primary key,
  value text not null
);`,
  },
  {
    id: 27,
    sql: `create table crew_workers (
  id text primary key,
  name text not null unique collate nocase,
  role text not null,
  brief text not null default '',
  tools_json text not null default '[]',
  created_at integer not null,
  last_at integer not null default 0
);`,
  },
];
