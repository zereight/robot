/**
 * Triggers that mark a row as changed, so sync can find it (spec 016). They only write while the
 * computer is in a sync pair. `id` is the SQL text of the sync id of the row.
 */
const dirtyTriggers = (table: string, kind: string, id: (row: "NEW" | "OLD") => string) =>
  (["INSERT", "UPDATE", "DELETE"] as const)
    .map((op) => {
      const row = op === "DELETE" ? "OLD" : "NEW"
      return `CREATE TRIGGER sync_dirty_${table}_${op.toLowerCase()} AFTER ${op} ON ${table}
        WHEN EXISTS (SELECT 1 FROM sync_pair)
        BEGIN INSERT OR REPLACE INTO sync_dirty (kind, id) VALUES ('${kind}', ${id(row)}); END;`
    })
    .join("\n")

const plainId = (row: "NEW" | "OLD") => `${row}.id`

/**
 * Schema migrations, in order. Never change a shipped entry; add a new one.
 * The index + 1 is stored as the database user version.
 */
export const migrations: readonly string[] = [
  `
  CREATE TABLE setting (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE ui_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE server (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    position INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  `
  CREATE TABLE agent (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES server (id),
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    role TEXT NOT NULL,
    instructions TEXT NOT NULL,
    face_shape INTEGER NOT NULL,
    face_hue INTEGER NOT NULL,
    face_image TEXT,
    model_account_id TEXT,
    model_name TEXT,
    model_effort TEXT,
    workspace TEXT NOT NULL,
    section TEXT NOT NULL,
    archived_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX agent_name ON agent (server_id, name_key);
  `,
  `
  CREATE TABLE provider_account (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  `
  CREATE TABLE message (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agent (id) ON DELETE CASCADE,
    author TEXT NOT NULL,
    parts TEXT NOT NULL,
    status TEXT NOT NULL,
    error_code TEXT,
    error_detail TEXT,
    error_resets_at INTEGER,
    reply_to TEXT,
    model TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    finished_at INTEGER,
    edited_at INTEGER
  );
  CREATE INDEX message_agent ON message (agent_id, created_at);
  ALTER TABLE agent ADD COLUMN last_read_at INTEGER NOT NULL DEFAULT 0;
  `,
  `
  CREATE TABLE task (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agent (id) ON DELETE CASCADE,
    prompt TEXT NOT NULL,
    label TEXT NOT NULL,
    source TEXT NOT NULL,
    source_id TEXT,
    parent_id TEXT,
    retry_of TEXT,
    message_id TEXT,
    state TEXT NOT NULL,
    error_code TEXT,
    error_detail TEXT,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER
  );
  CREATE INDEX task_agent ON task (agent_id, created_at);
  `,
  `
  CREATE TABLE channel (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES server (id),
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    topic TEXT NOT NULL,
    lead_agent_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_read_at INTEGER NOT NULL DEFAULT 0
  );
  CREATE UNIQUE INDEX channel_name ON channel (server_id, name_key);
  CREATE TABLE channel_member (
    channel_id TEXT NOT NULL REFERENCES channel (id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agent (id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    PRIMARY KEY (channel_id, agent_id)
  );
  CREATE TABLE channel_message (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channel (id) ON DELETE CASCADE,
    author TEXT NOT NULL,
    agent_id TEXT,
    kind TEXT NOT NULL DEFAULT 'text',
    parts TEXT NOT NULL,
    status TEXT NOT NULL,
    error_code TEXT,
    error_detail TEXT,
    error_resets_at INTEGER,
    task_id TEXT,
    awaiting INTEGER NOT NULL DEFAULT 0,
    model TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    finished_at INTEGER
  );
  CREATE INDEX channel_message_channel ON channel_message (channel_id, created_at);
  `,
  `
  ALTER TABLE agent ADD COLUMN permission TEXT NOT NULL DEFAULT 'ask_risky';
  ALTER TABLE agent ADD COLUMN memory_enabled INTEGER NOT NULL DEFAULT 1;
  CREATE TABLE agent_allow (
    agent_id TEXT NOT NULL REFERENCES agent (id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    PRIMARY KEY (agent_id, key)
  );
  CREATE TABLE memory (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agent (id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    source TEXT NOT NULL,
    message_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX memory_agent ON memory (agent_id, created_at);
  `,
  `
  CREATE TABLE routine (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL,
    agent_id TEXT NOT NULL REFERENCES agent (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    schedule TEXT NOT NULL,
    channel_id TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_checked_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE routine_skip (
    id TEXT PRIMARY KEY,
    routine_id TEXT NOT NULL REFERENCES routine (id) ON DELETE CASCADE,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL
  );
  CREATE INDEX routine_skip_at ON routine_skip (routine_id, at);
  `,
  `
  CREATE TABLE workflow (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL,
    name TEXT NOT NULL,
    trigger TEXT NOT NULL,
    steps TEXT NOT NULL,
    edges TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_checked_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE workflow_run (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflow (id) ON DELETE CASCADE,
    state TEXT NOT NULL,
    trigger TEXT NOT NULL,
    trigger_text TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER
  );
  CREATE INDEX workflow_run_workflow ON workflow_run (workflow_id, started_at);
  CREATE TABLE workflow_run_step (
    run_id TEXT NOT NULL REFERENCES workflow_run (id) ON DELETE CASCADE,
    step_id TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    state TEXT NOT NULL,
    input TEXT NOT NULL DEFAULT '',
    result TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    branch TEXT NOT NULL DEFAULT '',
    task_id TEXT,
    PRIMARY KEY (run_id, step_id)
  );
  `,
  `
  CREATE TABLE mute (
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    until INTEGER,
    PRIMARY KEY (kind, id)
  );
  `,
  `
  ALTER TABLE provider_account ADD COLUMN off INTEGER NOT NULL DEFAULT 0;
  `,
  `
  CREATE TABLE device_link (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    public_key TEXT NOT NULL,
    inbound INTEGER NOT NULL DEFAULT 0,
    outbound INTEGER NOT NULL DEFAULT 0,
    addresses TEXT NOT NULL DEFAULT '[]',
    server_id TEXT,
    position INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen INTEGER
  );
  ALTER TABLE message ADD COLUMN from_device TEXT;
  ALTER TABLE message ADD COLUMN from_name TEXT;
  ALTER TABLE channel_message ADD COLUMN from_device TEXT;
  ALTER TABLE channel_message ADD COLUMN from_name TEXT;
  `,
  `
  ALTER TABLE message ADD COLUMN origin TEXT;
  ALTER TABLE channel_message ADD COLUMN origin TEXT;
  ALTER TABLE task ADD COLUMN origin TEXT;
  ALTER TABLE workflow_run ADD COLUMN origin TEXT;
  ALTER TABLE routine ADD COLUMN runs_on TEXT;
  ALTER TABLE workflow ADD COLUMN runs_on TEXT;
  CREATE TABLE sync_pair (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    peer_id TEXT NOT NULL,
    peer_name TEXT NOT NULL,
    role TEXT NOT NULL,
    mode TEXT NOT NULL,
    phase TEXT NOT NULL,
    paused INTEGER NOT NULL DEFAULT 0,
    ctl INTEGER NOT NULL DEFAULT 0,
    backed_up INTEGER NOT NULL DEFAULT 0,
    stamped INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    synced_at INTEGER,
    out_total INTEGER NOT NULL DEFAULT 0,
    out_done INTEGER NOT NULL DEFAULT 0,
    out_cursor TEXT NOT NULL DEFAULT '',
    out_complete INTEGER NOT NULL DEFAULT 0,
    in_total INTEGER NOT NULL DEFAULT 0,
    in_done INTEGER NOT NULL DEFAULT 0,
    in_cursor TEXT NOT NULL DEFAULT '',
    in_complete INTEGER NOT NULL DEFAULT 0,
    in_force INTEGER NOT NULL DEFAULT 0,
    applied_seq INTEGER NOT NULL DEFAULT 0,
    clock_offset INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE sync_item (
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    origin TEXT NOT NULL,
    parent_kind TEXT,
    parent_id TEXT,
    initial INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (kind, id)
  ) WITHOUT ROWID;
  CREATE INDEX sync_item_parent ON sync_item (parent_kind, parent_id);
  CREATE TABLE sync_field (
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    field TEXT NOT NULL,
    l INTEGER NOT NULL,
    c INTEGER NOT NULL,
    n TEXT NOT NULL,
    h TEXT NOT NULL,
    aseq INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (kind, id, field)
  ) WITHOUT ROWID;
  CREATE TABLE sync_tomb (
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    l INTEGER NOT NULL,
    c INTEGER NOT NULL,
    n TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (kind, id)
  ) WITHOUT ROWID;
  CREATE TABLE sync_out (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    op TEXT NOT NULL,
    ver INTEGER NOT NULL DEFAULT 1,
    UNIQUE (kind, id)
  );
  CREATE TABLE sync_dirty (
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    PRIMARY KEY (kind, id)
  ) WITHOUT ROWID;
  CREATE TABLE sync_seen (
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    PRIMARY KEY (kind, id)
  ) WITHOUT ROWID;
  CREATE TABLE sync_alias (
    peer_id TEXT PRIMARY KEY,
    local_id TEXT NOT NULL
  );
  CREATE TABLE sync_change (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    item_id TEXT NOT NULL,
    name TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE sync_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  ${dirtyTriggers("provider_account", "account", plainId)}
  ${dirtyTriggers("agent", "agent", plainId)}
  ${dirtyTriggers("channel", "channel", plainId)}
  ${dirtyTriggers("channel_member", "channel", (row) => `${row}.channel_id`)}
  ${dirtyTriggers("memory", "memory", plainId)}
  ${dirtyTriggers("message", "message", plainId)}
  ${dirtyTriggers("channel_message", "cmessage", plainId)}
  ${dirtyTriggers("routine", "routine", plainId)}
  ${dirtyTriggers("workflow", "workflow", plainId)}
  ${dirtyTriggers("task", "task", plainId)}
  ${dirtyTriggers("routine_skip", "rskip", plainId)}
  ${dirtyTriggers("workflow_run", "wrun", plainId)}
  ${dirtyTriggers("workflow_run_step", "wstep", (row) => `${row}.run_id || '|' || ${row}.step_id`)}
  `,
  `
  -- The switch "Can create and change agents" of each linked device (spec 012). A link made before
  -- this switch existed has it off.
  ALTER TABLE device_link ADD COLUMN can_change INTEGER NOT NULL DEFAULT 0;
  -- The last change that a linked device made to an agent: its name then, and the time.
  ALTER TABLE agent ADD COLUMN changed_by TEXT;
  ALTER TABLE agent ADD COLUMN changed_at INTEGER;
  `,
]
