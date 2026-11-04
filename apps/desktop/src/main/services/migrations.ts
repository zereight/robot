/**
 * Triggers that mark a row as changed, so sync can find it (spec 019). They only write while the
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
 * Triggers that keep the text table of message search in step with one message table (spec 001).
 * `place` is the column that names the chat or the channel of a row. A row with no text, or one
 * that still streams, has no entry. The old entry goes first, so a write that replaces a row
 * (which fires no delete trigger) leaves no second entry.
 */
const searchTriggers = (table: string, kind: string, place: string) => {
  const rewrite = `DELETE FROM message_text WHERE kind = '${kind}' AND message_id = NEW.id;
    INSERT INTO message_text (kind, message_id, place_id, created_at, body)
      SELECT '${kind}', NEW.id, NEW.${place}, NEW.created_at, b FROM (
        SELECT CASE WHEN NEW.status <> 'streaming' AND json_valid(NEW.parts) THEN
          (SELECT group_concat(t, '') FROM (
            SELECT json_extract(j.value, '$.text') AS t FROM json_each(NEW.parts) AS j
            WHERE json_extract(j.value, '$.kind') = 'text' ORDER BY j.key))
        END AS b
      ) WHERE b IS NOT NULL AND b <> '';`
  return `
  CREATE TRIGGER ${table}_text_insert AFTER INSERT ON ${table} BEGIN
    ${rewrite}
  END;
  CREATE TRIGGER ${table}_text_update AFTER UPDATE OF parts, status, ${place} ON ${table} BEGIN
    ${rewrite}
  END;
  CREATE TRIGGER ${table}_text_delete AFTER DELETE ON ${table} BEGIN
    DELETE FROM message_text WHERE kind = '${kind}' AND message_id = OLD.id;
  END;`
}

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
  ALTER TABLE agent ADD COLUMN knowledge_enabled INTEGER NOT NULL DEFAULT 1;
  CREATE TABLE knowledge_file (
    agent_id TEXT NOT NULL REFERENCES agent (id) ON DELETE CASCADE,
    file TEXT NOT NULL,
    hash TEXT NOT NULL,
    editor TEXT NOT NULL,
    content TEXT NOT NULL,
    PRIMARY KEY (agent_id, file)
  );
  CREATE TABLE knowledge_change (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agent (id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    file TEXT NOT NULL,
    earlier TEXT,
    actor TEXT NOT NULL,
    at INTEGER NOT NULL,
    undone_at INTEGER
  );
  CREATE INDEX knowledge_change_agent ON knowledge_change (agent_id, at);
  `,
  `
  ALTER TABLE workflow ADD COLUMN notes TEXT NOT NULL DEFAULT '[]';
  `,
  `
  CREATE TABLE place_section (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES server (id),
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    position INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX place_section_name ON place_section (server_id, kind, name_key);
  ALTER TABLE agent ADD COLUMN place_section_id TEXT REFERENCES place_section (id) ON DELETE SET NULL;
  ALTER TABLE channel ADD COLUMN place_section_id TEXT REFERENCES place_section (id) ON DELETE SET NULL;
  `,
  `
  ALTER TABLE provider_account ADD COLUMN sign_in TEXT;
  `,
  `
  ALTER TABLE message ADD COLUMN context TEXT;
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
  `
  -- The action log (spec 007). It stays on this computer and does not sync (spec 019). An entry
  -- keeps the name of its agent, so it outlives the agent. \`outside\` holds the first source of
  -- outside content of the turn, as JSON, or NULL when the turn held none.
  CREATE TABLE action_log (
    id TEXT PRIMARY KEY,
    at INTEGER NOT NULL,
    agent_id TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    kind TEXT NOT NULL,
    target TEXT NOT NULL,
    decided_by TEXT NOT NULL,
    result TEXT NOT NULL,
    task_id TEXT,
    outside TEXT
  );
  CREATE INDEX action_log_at ON action_log (at);
  `,
  `
  -- A message that the user sent into a running turn (spec 003): the reply of that turn, and the
  -- time when the agent read the message. Both are empty for every other message.
  ALTER TABLE message ADD COLUMN joined_to TEXT;
  ALTER TABLE message ADD COLUMN read_at INTEGER;
  `,
  `
  -- Skills (spec 017): saved instructions that the user calls in a chat. They stay on this
  -- computer: sync does not carry them (spec 019). \`agents\` is a JSON list of agent ids, or NULL
  -- for all agents.
  CREATE TABLE skill (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES server (id),
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    instructions TEXT NOT NULL,
    agents TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX skill_name ON skill (server_id, name_key);
  `,
  `
  -- The checklist that an import leaves for a new agent or a new workflow (spec 014). It belongs
  -- to this computer and does not sync.
  CREATE TABLE import_checklist (
    id TEXT PRIMARY KEY,
    agent_id TEXT REFERENCES agent (id) ON DELETE CASCADE,
    workflow_id TEXT REFERENCES workflow (id) ON DELETE CASCADE,
    items TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX import_checklist_agent ON import_checklist (agent_id);
  CREATE INDEX import_checklist_workflow ON import_checklist (workflow_id);
  `,
  `
  -- The times of a task (spec 005): when the message that started it was sent, and when the first
  -- part of the reply that the user can see was stored. Both stay empty when they are not known.
  ALTER TABLE task ADD COLUMN asked_at INTEGER;
  ALTER TABLE task ADD COLUMN first_reply_at INTEGER;
  `,
  `
  -- Message search (spec 001). The text of the sent messages of chats and channels, in a table of
  -- its own, with an index that finds a part of a word without case (the trigram index). Triggers
  -- keep it in step with every write to the two message tables, also a write by sync, by an
  -- import, or by a delete that cascades from an agent or a channel. A reply that still streams
  -- is not in it; it goes in when the reply ends. Tool cards, thinking and files are not text.
  CREATE TABLE message_text (
    n INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,
    message_id TEXT NOT NULL,
    place_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    body TEXT NOT NULL
  );
  CREATE UNIQUE INDEX message_text_message ON message_text (kind, message_id);
  CREATE INDEX message_text_time ON message_text (created_at, n);
  INSERT INTO message_text (kind, message_id, place_id, created_at, body)
    SELECT kind, id, place_id, created_at, body FROM (
      SELECT 'chat' AS kind, m.id AS id, m.agent_id AS place_id, m.created_at AS created_at,
        m.status AS status,
        (SELECT group_concat(t, '') FROM (
          SELECT json_extract(j.value, '$.text') AS t FROM json_each(m.parts) AS j
          WHERE json_extract(j.value, '$.kind') = 'text' ORDER BY j.key)) AS body
      FROM message m WHERE json_valid(m.parts)
    ) WHERE body IS NOT NULL AND body <> '' AND status <> 'streaming';
  INSERT INTO message_text (kind, message_id, place_id, created_at, body)
    SELECT kind, id, place_id, created_at, body FROM (
      SELECT 'channel' AS kind, m.id AS id, m.channel_id AS place_id, m.created_at AS created_at,
        m.status AS status,
        (SELECT group_concat(t, '') FROM (
          SELECT json_extract(j.value, '$.text') AS t FROM json_each(m.parts) AS j
          WHERE json_extract(j.value, '$.kind') = 'text' ORDER BY j.key)) AS body
      FROM channel_message m WHERE json_valid(m.parts)
    ) WHERE body IS NOT NULL AND body <> '' AND status <> 'streaming';
  CREATE VIRTUAL TABLE message_fts USING fts5(
    body, content = 'message_text', content_rowid = 'n', tokenize = 'trigram'
  );
  INSERT INTO message_fts (message_fts) VALUES ('rebuild');
  CREATE TRIGGER message_text_fts_insert AFTER INSERT ON message_text BEGIN
    INSERT INTO message_fts (rowid, body) VALUES (NEW.n, NEW.body);
  END;
  CREATE TRIGGER message_text_fts_delete AFTER DELETE ON message_text BEGIN
    INSERT INTO message_fts (message_fts, rowid, body) VALUES ('delete', OLD.n, OLD.body);
  END;
  ${searchTriggers("message", "chat", "agent_id")}
  ${searchTriggers("channel_message", "channel", "channel_id")}
  `,
  `
  -- Memory control (spec 008). None of this syncs (spec 019): no dirty trigger is made here, and
  -- the choice of an agent is not a field of the agent that sync carries.
  -- "now" is "Save at once", "ask" is "Ask me first".
  ALTER TABLE agent ADD COLUMN memory_mode TEXT NOT NULL DEFAULT 'now';
  -- A fact that an agent suggests. It is not memory. Where it came from is the chat of the agent
  -- ("agent") or a channel ("channel").
  CREATE TABLE memory_proposal (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agent (id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    place_kind TEXT,
    place_id TEXT,
    message_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX memory_proposal_agent ON memory_proposal (agent_id, created_at);
  -- The changes to the memory of an agent. memory_id is the item at the time of the change.
  -- actor: user, agent, proposal, undo. kind: added, edited, deleted. undo_of is the row that an
  -- undo took back. undone_by is the undo row that took this one back, until that undo is undone.
  CREATE TABLE memory_history (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agent (id) ON DELETE CASCADE,
    memory_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    actor TEXT NOT NULL,
    kind TEXT NOT NULL,
    source TEXT NOT NULL,
    old_text TEXT,
    new_text TEXT,
    hidden INTEGER NOT NULL DEFAULT 0,
    undo_of TEXT,
    undone_by TEXT
  );
  CREATE INDEX memory_history_agent ON memory_history (agent_id, at);
  `,
  `
  -- Saved secrets (spec 020). The value is in the system keychain, under the name in
  -- \`value_ref\`; it is never in this database. \`value_ref\` is NULL when this computer holds no
  -- value, for example after an import. The table stays on this computer: no trigger of sync
  -- watches it (spec 019).
  CREATE TABLE saved_secret (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    origin TEXT NOT NULL,
    auth TEXT NOT NULL,
    value_ref TEXT,
    saved_at INTEGER NOT NULL,
    last_used_at INTEGER,
    UNIQUE (agent_id, name_key)
  );
  -- The keychain names of values that must go: the app removes them and then the rows.
  CREATE TABLE saved_secret_drop (
    value_ref TEXT PRIMARY KEY
  ) WITHOUT ROWID;
  -- Deleting an agent deletes its secrets, also when sync deletes the agent.
  CREATE TRIGGER saved_secret_agent_gone AFTER DELETE ON agent BEGIN
    INSERT OR IGNORE INTO saved_secret_drop (value_ref)
      SELECT value_ref FROM saved_secret WHERE agent_id = OLD.id AND value_ref IS NOT NULL;
    DELETE FROM saved_secret WHERE agent_id = OLD.id;
  END;
  `,
  `
  -- The instruction history of each agent (spec 002). It goes with the agent in an export (014)
  -- and in sync (019), and goes when the agent is deleted.
  CREATE TABLE instruction_version (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agent (id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX instruction_version_agent ON instruction_version (agent_id, created_at);
  ${dirtyTriggers("instruction_version", "iversion", plainId)}
  `,
  `
  -- Watch routines and the model of a routine (spec 009). A routine has one trigger: \`schedule\`
  -- holds the JSON of a schedule, or the JSON null for a watch, and \`watch\` holds the JSON of a
  -- watch, or NULL. \`model_*\` are NULL for "Same as the agent".
  ALTER TABLE routine ADD COLUMN watch TEXT;
  ALTER TABLE routine ADD COLUMN model_account_id TEXT;
  ALTER TABLE routine ADD COLUMN model_name TEXT;
  ALTER TABLE routine ADD COLUMN model_effort TEXT;
  -- A failed check, or a run that could not start, is an entry of kind 'failed' with its reason.
  ALTER TABLE routine_skip ADD COLUMN reason TEXT;
  -- What stays on this computer for each routine (spec 019): the count of failed runs in a row,
  -- the reason when it paused itself, and the last result of its watch with the time of the check.
  CREATE TABLE routine_state (
    routine_id TEXT PRIMARY KEY REFERENCES routine (id) ON DELETE CASCADE,
    failed_runs INTEGER NOT NULL DEFAULT 0,
    paused_failure TEXT,
    watch_result TEXT,
    watch_checked_at INTEGER
  );
  `,
  `
  -- How deep a task is in a chain of messages between agents (spec 005, "Limits of a task").
  ALTER TABLE task ADD COLUMN depth INTEGER NOT NULL DEFAULT 0;
  -- For a step of a file, whether it read or wrote (spec 007, "Action log"). It is NULL for every
  -- other kind of step. The retry note (spec 005) reads the entries of a task by its id.
  ALTER TABLE action_log ADD COLUMN access TEXT;
  CREATE INDEX action_log_task ON action_log (task_id, at);
  `,
  `
  -- How far the turn of a task went: not_sent, sent or started (spec 005). It only goes up. A task
  -- from before this step has none, and shows no line about it.
  ALTER TABLE task ADD COLUMN progress TEXT;
  `,
  `
  -- Review of parts (spec 004). "Review parts" is a setting of the channel, off at first. It syncs
  -- with the channel (spec 019): the dirty trigger of the channel already watches every column.
  ALTER TABLE channel ADD COLUMN review_parts INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- The done test and the verdict of a part (spec 004, 005). Only fields are added: a task from
  -- before this step has no done test and no verdict, and the check does not read it. The verdict
  -- is a field, not a state (the state of the part stays "done"). \`decided_at\` is when the user
  -- accepted the part or asked for changes: the check gives no verdict to such a part.
  -- The dirty trigger of the task already watches every column.
  ALTER TABLE task ADD COLUMN done_test TEXT;
  ALTER TABLE task ADD COLUMN verdict TEXT;
  ALTER TABLE task ADD COLUMN verdict_reason TEXT;
  ALTER TABLE task ADD COLUMN judged_at INTEGER;
  ALTER TABLE task ADD COLUMN decided_at INTEGER;
  `,
  `
  -- The linked device that started a run, and the one that answered an approval step (spec 012,
  -- "Workflows"). NULL for the window of this computer. They stay on this computer: sync (019)
  -- does not carry them.
  ALTER TABLE workflow_run ADD COLUMN started_by TEXT;
  ALTER TABLE workflow_run_step ADD COLUMN decided_by TEXT;
  `,
  `
  -- The moments of a task (spec 005). \`ended_at\` is when the turn ended and \`ended_as\` how
  -- (done, failed, blocked, cancelled, review). A task from before this step, a task that never
  -- started, and a task that the app stopped have none: the real time is not known. \`decision\` is
  -- what the user decided on a part (accepted, changes) and \`decision_text\` the text of the request
  -- for changes. Only fields are added. The dirty trigger of the task watches every column.
  ALTER TABLE task ADD COLUMN ended_at INTEGER;
  ALTER TABLE task ADD COLUMN ended_as TEXT;
  ALTER TABLE task ADD COLUMN decision TEXT;
  ALTER TABLE task ADD COLUMN decision_text TEXT;
  `,
  `
  -- Browser profiles: named sets of saved browser data (cookies, sign-ins) on this computer, and
  -- which agent uses which. An agent with no row here uses its own data. Both tables stay on this
  -- computer: sync (019) does not carry them, and neither does an export, as browser sessions do
  -- not. A profile that is deleted frees its agents, and an agent that is deleted leaves its row.
  CREATE TABLE browser_profile (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE agent_browser (
    agent_id TEXT PRIMARY KEY REFERENCES agent (id) ON DELETE CASCADE,
    profile_id TEXT NOT NULL REFERENCES browser_profile (id) ON DELETE CASCADE
  );
  CREATE INDEX agent_browser_profile ON agent_browser (profile_id);
  `,
  `
  -- The mark of a sensitive read (spec 007, "Sensitive places"). A chat (the agent) or a channel
  -- whose next turn holds a sensitive read has the label of the first credential place that was
  -- read, or NULL. It is stored with the place and syncs with it (spec 019): the dirty trigger of
  -- the agent and of the channel already watches every column. The action log says whether the
  -- turn of a step held a sensitive read, with the same label or NULL.
  ALTER TABLE agent ADD COLUMN sensitive_mark TEXT;
  ALTER TABLE channel ADD COLUMN sensitive_mark TEXT;
  ALTER TABLE action_log ADD COLUMN sensitive TEXT;
  `,
  `
  -- Threads (spec 003, "Threads"). A thread is a second conversation with the same agent. The main
  -- thread has no row: a message with no thread is in the main thread, so every message from before
  -- this step stays there. A thread syncs (spec 019) like a message. \`titled\` is 1 when the title
  -- is fixed: by the user, by a fork, or by the first message. A fork keeps a link to its source
  -- thread (NULL for the main thread) and message; it does not change when the source goes.
  CREATE TABLE thread (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agent (id) ON DELETE CASCADE,
    title TEXT,
    titled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    archived_at INTEGER,
    fork_thread_id TEXT,
    fork_message_id TEXT
  );
  CREATE INDEX thread_agent ON thread (agent_id, created_at);
  ${dirtyTriggers("thread", "thread", plainId)}
  ALTER TABLE message ADD COLUMN thread_id TEXT REFERENCES thread (id) ON DELETE CASCADE;
  CREATE INDEX message_thread ON message (thread_id, created_at);
  -- When the user last read a thread, for its unread count. It stays on this computer, as the
  -- read time of the main thread does.
  CREATE TABLE thread_read (
    thread_id TEXT PRIMARY KEY REFERENCES thread (id) ON DELETE CASCADE,
    at INTEGER NOT NULL
  );
  -- The pause of automatic compact for one conversation (spec 003): the number of turns that must
  -- end before the next try. \`thread_id\` is '' for the main thread. It stays on this computer.
  CREATE TABLE compact_pause (
    agent_id TEXT NOT NULL REFERENCES agent (id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL DEFAULT '',
    turns INTEGER NOT NULL,
    PRIMARY KEY (agent_id, thread_id)
  );
  `,
  `
  -- The marks of a thread (spec 007, "The mark of a place"). A thread is a place of its own: a new
  -- thread starts with no mark, and a handover (spec 003) gives it the marks of the place it came
  -- from. The mark syncs with the thread (spec 019); \`updated_at\` moves when a mark changes, so
  -- sync stamps the change as new. The dirty trigger of the thread already watches every column.
  ALTER TABLE thread ADD COLUMN sensitive_mark TEXT;
  ALTER TABLE thread ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- The Teams link (spec 028). One row at most: a profile has one link. The row exists after the
  -- user presses "Set up". It belongs to this computer and this profile: sync (019) does not carry
  -- it, and an export deletes it. The target has no foreign key: an agent that is deleted leaves
  -- the link in the state "Target missing". The two lists are JSON arrays of names.
  CREATE TABLE teams_link (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    target_kind TEXT,
    target_id TEXT,
    chat_title TEXT NOT NULL DEFAULT '',
    chat_kind TEXT NOT NULL DEFAULT 'person',
    allow_list TEXT NOT NULL DEFAULT '[]',
    bot_list TEXT NOT NULL DEFAULT '[]',
    call_text TEXT NOT NULL DEFAULT '',
    marker TEXT NOT NULL DEFAULT '[ROBot]',
    enabled INTEGER NOT NULL DEFAULT 0,
    signed_in INTEGER NOT NULL DEFAULT 0,
    last_read_at INTEGER
  );
  -- The sign-in profile of the link is a browser profile that the app makes. "purpose" is null for
  -- a profile of the user and 'teams' for this one. No agent gets it, and it is not in the limit.
  ALTER TABLE browser_profile ADD COLUMN purpose TEXT;
  `,
  `
  -- The outside mark of a place and of a message (spec 007, "Outside content" and "Program mark").
  -- \`outside_mark\` is JSON text, or NULL: the first source of the outside content that the next
  -- turns of a chat (the agent), a thread or a channel hold, and whether it holds the program mark.
  -- It is stored with the place and syncs with it (spec 019): the dirty trigger of each table
  -- already watches every column, and \`updated_at\` moves when a mark changes. \`program_mark\` is
  -- JSON text, or NULL: the first source of a turn that holds the program mark, on each message
  -- that the turn started or made. A fork, a hit of "search chats" and a read of an old message use
  -- it to know that a message came from such a turn. It syncs with the message.
  ALTER TABLE agent ADD COLUMN outside_mark TEXT;
  ALTER TABLE channel ADD COLUMN outside_mark TEXT;
  ALTER TABLE thread ADD COLUMN outside_mark TEXT;
  ALTER TABLE message ADD COLUMN program_mark TEXT;
  ALTER TABLE channel_message ADD COLUMN program_mark TEXT;
  `,
  `
  -- Permission rules (spec 007, "Permission rules"). A rule is for one agent (agent_id) or for all
  -- agents of the server (agent_id is NULL). The column kind is file, shell, web, connection or
  -- secret. The column match_text is the path, the command, the host, the connection or the
  -- secret. The column detail is the tool or the method, and NULL for "any tool" or "any method".
  -- A rule that this build cannot read (an unknown kind or decision) stays in the table and
  -- allows or denies nothing. Deleting an agent deletes its rules. The rules stay on this
  -- computer and do not sync (spec 019): the table has no dirty trigger.
  CREATE TABLE permission_rule (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL,
    agent_id TEXT REFERENCES agent (id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    match_text TEXT NOT NULL,
    detail TEXT,
    decision TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX permission_rule_server ON permission_rule (server_id, created_at);
  CREATE INDEX permission_rule_agent ON permission_rule (agent_id);
  -- The rule that decided a step, kept with the entry. The text stays when the rule is deleted.
  ALTER TABLE action_log ADD COLUMN rule_id TEXT;
  ALTER TABLE action_log ADD COLUMN rule_kind TEXT;
  ALTER TABLE action_log ADD COLUMN rule_text TEXT;
  ALTER TABLE action_log ADD COLUMN rule_detail TEXT;
  -- The old "Always allow" keys become Allow rules. A rule is never wider than its key was. A key
  -- of a whole class of steps (all commands that install software, every read outside the
  -- workspace, every fetch of a page, a browser step, a tool that the app does not know) has no
  -- rule that means the same. It is dropped, and the step asks again.
  -- Shell command: the key holds the command, or the first word of a command.
  INSERT INTO permission_rule (id, server_id, agent_id, kind, match_text, detail, decision, source, created_at)
  SELECT lower(hex(randomblob(16))), a.server_id, k.agent_id, 'shell', k.text, NULL, 'allow', 'card',
         CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM (
    SELECT agent_id,
           CASE WHEN key LIKE 'run_command:control:%' THEN substr(key, 21) ELSE substr(key, 13) END AS text
    FROM agent_allow WHERE key LIKE 'run_command:%'
  ) k JOIN agent a ON a.id = k.agent_id
  WHERE k.text <> '' AND length(k.text) <= 500
    AND k.text NOT IN ('sudo', 'install', 'network', 'shell_pipe', 'delete_outside');
  -- Files: the key holds the full path. A key of the class "inside the workspace" or "outside"
  -- has no path and is dropped.
  INSERT INTO permission_rule (id, server_id, agent_id, kind, match_text, detail, decision, source, created_at)
  SELECT lower(hex(randomblob(16))), a.server_id, k.agent_id, 'file', k.text, NULL, 'allow', 'card',
         CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM (
    SELECT agent_id,
           CASE WHEN key LIKE 'write_file:control:%' THEN substr(key, 20)
                WHEN key LIKE 'write_file:%' OR key LIKE 'list_files:%' THEN substr(key, 12)
                ELSE substr(key, 11) END AS text
    FROM agent_allow
    WHERE key LIKE 'write_file:control:/%' OR key LIKE 'write_file:/%'
       OR key LIKE 'read_file:/%' OR key LIKE 'list_files:/%'
  ) k JOIN agent a ON a.id = k.agent_id
  WHERE length(k.text) BETWEEN 1 AND 500;
  -- Web pages: the key holds the host.
  INSERT INTO permission_rule (id, server_id, agent_id, kind, match_text, detail, decision, source, created_at)
  SELECT lower(hex(randomblob(16))), a.server_id, k.agent_id, 'web', lower(k.text), NULL, 'allow', 'card',
         CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM (
    SELECT agent_id,
           CASE WHEN key LIKE 'fetch_url:local:%' THEN substr(key, 17) ELSE substr(key, 9) END AS text
    FROM agent_allow WHERE key LIKE 'fetch_url:local:%' OR key LIKE 'network:%'
  ) k JOIN agent a ON a.id = k.agent_id
  WHERE length(k.text) BETWEEN 1 AND 500;
  -- Requests with a saved secret: the key holds the name and the method, or * for any method.
  INSERT INTO permission_rule (id, server_id, agent_id, kind, match_text, detail, decision, source, created_at)
  SELECT lower(hex(randomblob(16))), a.server_id, k.agent_id, 'secret',
         substr(k.rest, 1, length(k.rest) - length(m.suffix)), m.method, 'allow', 'card',
         CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM (SELECT agent_id, substr(key, 16) AS rest FROM agent_allow WHERE key LIKE 'secret_request:%') k
  JOIN (
    SELECT ':GET' AS suffix, 'GET' AS method UNION ALL SELECT ':POST', 'POST'
    UNION ALL SELECT ':PUT', 'PUT' UNION ALL SELECT ':PATCH', 'PATCH'
    UNION ALL SELECT ':DELETE', 'DELETE' UNION ALL SELECT ':*', NULL
  ) m ON substr(k.rest, -length(m.suffix)) = m.suffix
  JOIN agent a ON a.id = k.agent_id
  WHERE length(k.rest) > length(m.suffix) AND length(k.rest) - length(m.suffix) <= 500;
  -- Two keys can make the same rule. One stays.
  DELETE FROM permission_rule WHERE rowid NOT IN (
    SELECT MIN(rowid) FROM permission_rule
    GROUP BY server_id, agent_id, kind, match_text, IFNULL(detail, ''), decision
  );
  DROP TABLE agent_allow;
  `,
  `
  -- The mark "From Teams" (spec 028): the name of the sender, as the Teams page showed it, on a
  -- message that a Teams chat sent to a direct chat or a channel. NULL for any other message. The
  -- name is stored with the message, as the text is, and syncs with it (spec 019).
  ALTER TABLE message ADD COLUMN teams_sender TEXT;
  ALTER TABLE channel_message ADD COLUMN teams_sender TEXT;
  `,
  `
  -- The records of the Teams link (spec 028, "Records"): an answer that did not go out, with the
  -- time, the reason, the place and the task. A record holds no text of a message and no name of a
  -- sender. The service keeps the newest 50. The table belongs to this computer and this profile:
  -- sync (019) does not carry it, and an export deletes it. The place and the task have no foreign
  -- key: an agent, a channel or a task that goes leaves the record, and the window shows no name.
  CREATE TABLE teams_record (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    reason TEXT NOT NULL,
    place_kind TEXT,
    place_id TEXT,
    task_id TEXT
  );
  `,
  `
  -- The pause of the Teams link (spec 028, "States and errors"): why it paused ('read' or 'send')
  -- and when. NULL while the link is not paused. A restart keeps the pause until the user presses
  -- "Resume". The columns hold no text of a message and no name.
  ALTER TABLE teams_link ADD COLUMN paused TEXT;
  ALTER TABLE teams_link ADD COLUMN paused_at INTEGER;
  `,
  `
  -- How a channel job began, when a message from Teams began it (spec 028, "Answers and the
  -- outbox"): 'lead' (the lead read it) or 'mention' (a member that was chosen answers it). The
  -- parts, the retries, the nudges and the requests for changes of the job keep it. NULL for any
  -- other task. The link reads it to know which work sends text to Teams. Sync (019) does not
  -- carry it: the link belongs to one computer.
  ALTER TABLE task ADD COLUMN teams_job TEXT;
  `,
  `
  -- Connections (spec 018): outside tool providers that speak MCP. A connection belongs to this
  -- computer and does not sync (spec 019): the table has no dirty trigger. Secret values are in the
  -- system keychain and never in this table (spec 014): \`env\` and \`headers\` are JSON lists of
  -- {name, secret, value, saved}. A secret entry has no value here, only \`saved\`, which says that
  -- the keychain of this computer holds a value. \`tools\` is the list that the connection offered
  -- the last time that the app read it, and \`tools_off\` holds the names of tools that the user
  -- turned off. \`agents\` is NULL for all agents, or a JSON list of agent ids.
  CREATE TABLE tool_connection (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    command TEXT NOT NULL DEFAULT '',
    args TEXT NOT NULL DEFAULT '[]',
    folder TEXT NOT NULL DEFAULT '',
    env TEXT NOT NULL DEFAULT '[]',
    address TEXT NOT NULL DEFAULT '',
    headers TEXT NOT NULL DEFAULT '[]',
    agents TEXT,
    enabled INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'untested',
    failure TEXT,
    tools TEXT NOT NULL DEFAULT '[]',
    tools_more INTEGER NOT NULL DEFAULT 0,
    tools_off TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX tool_connection_name ON tool_connection (server_id, name_key);
  `,
  `
  -- Review of connection tools (spec 018, "Tool review"). \`reviewed\` is a JSON list of the tools
  -- that the user has seen and accepted: for each the name, the description, the names and
  -- descriptions of its parameters, and the read-only mark. The list \`tools\` keeps the same
  -- parts for what the connection offered the last time that the app read it, so the table holds
  -- the old and the new text of a held tool. \`review_adopt\` is 1 for a connection that existed
  -- before this rule: the tools that it offers at its first start after the update become its
  -- reviewed tools. A new connection, an imported one and one whose way to the server changed have
  -- 0 and an empty list, so their tools are all held at the first start. The reviewed tools stay
  -- on this computer: sync (019) does not carry the table, and an export empties both columns.
  ALTER TABLE tool_connection ADD COLUMN reviewed TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE tool_connection ADD COLUMN review_adopt INTEGER NOT NULL DEFAULT 0;
  UPDATE tool_connection SET review_adopt = 1;
  `,
  `
  -- The kind of a message from another agent that made a task (spec 029, "New data later"): 'send'
  -- for the tool "send message", 'reply' for the answer that comes back to the sender. Both tasks
  -- have the source 'agent' and name the other agent, so only this mark tells them apart. The org
  -- chart counts the marks 'send'. NULL for every other task, for a retry, and for a task from
  -- before this step: an old task is not counted, because it cannot be told from a reply. The mark
  -- syncs with the task (spec 019): the dirty trigger of the task already watches every column.
  ALTER TABLE task ADD COLUMN agent_message TEXT;
  CREATE INDEX task_hand_off ON task (created_at) WHERE agent_message = 'send';
  `,
  `
  -- The settings of the models of an account (spec 006, "Model list"). They belong to this
  -- computer: sync (019) does not carry the table, so it has no dirty trigger. A row exists for a
  -- model that this computer saw in a list of the account, and for a model ID that the user
  -- typed (\`typed\` = 1). \`seen_at\` is when a LATER fetch first listed the model, in ms since the
  -- epoch; it is NULL for a model of the first fetch of the account, which gets no tag "New".
  -- \`hidden\` is 1 for a model that the user turned off in the part "Models". \`context_size\` and
  -- \`output_limit\` are the optional fields of a custom model, in tokens. An export keeps the
  -- table and an import brings it back with its account. No secret is in it.
  CREATE TABLE provider_model (
    account_id TEXT NOT NULL,
    model TEXT NOT NULL,
    seen_at INTEGER,
    hidden INTEGER NOT NULL DEFAULT 0,
    context_size INTEGER,
    output_limit INTEGER,
    typed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, model)
  );
  `,
  `
  -- The backup model of an agent (spec 006, "Backup model"). \`backup_*\` are NULL for "None". The
  -- choice is a setting of the agent: it syncs with the agent (spec 019, the dirty trigger of the
  -- agent already watches every column), travels with a client of a linked server (spec 012), and
  -- an export keeps it with the agent (spec 014).
  ALTER TABLE agent ADD COLUMN backup_account_id TEXT;
  ALTER TABLE agent ADD COLUMN backup_model TEXT;
  ALTER TABLE agent ADD COLUMN backup_effort TEXT;
  -- The hold of the main model of an agent (spec 006): until \`ends_at\` (ms since the epoch) every
  -- turn of the agent uses the backup model. \`released\` is 1 after the user pressed "Use the main
  -- model now": the hold no longer counts, and the row tells that a limit that comes back before
  -- \`ends_at\` starts the hold again with no second line in the chat. The hold is a state of this
  -- computer: sync (019) does not carry the table, so it has no dirty trigger, and an export
  -- deletes it. It stays after a restart.
  CREATE TABLE model_hold (
    agent_id TEXT PRIMARY KEY REFERENCES agent (id) ON DELETE CASCADE,
    ends_at INTEGER NOT NULL,
    released INTEGER NOT NULL DEFAULT 0
  );
  `,
  `
  -- The usage of a task (spec 005, "Usage of a task") and the token limit of a routine (spec 009).
  -- The four numbers are what the turns of THIS task used, as the provider reports them: input
  -- tokens (cached input counts as input), output tokens, the cached part of the input, and the
  -- cost that the provider reports, in millionths of a US dollar. A number that the provider did not
  -- report is NULL, never 0, and the window shows "—". The total of a tree is worked out from the
  -- tasks below, not stored. \`token_limit\` on a task is the limit that its run started with: only
  -- the first task of a run of a routine that has a limit holds it, so a later edit of the routine
  -- does not change a run that went. The numbers hold no text of a message. They sync with the
  -- task (spec 019, the dirty trigger of the task watches every column) and an export keeps them
  -- (spec 014). \`routine.token_limit\` is the limit of one run, NULL for no limit; it syncs with
  -- the routine.
  ALTER TABLE task ADD COLUMN input_tokens INTEGER;
  ALTER TABLE task ADD COLUMN output_tokens INTEGER;
  ALTER TABLE task ADD COLUMN cached_tokens INTEGER;
  ALTER TABLE task ADD COLUMN cost_micros INTEGER;
  ALTER TABLE task ADD COLUMN token_limit INTEGER;
  ALTER TABLE routine ADD COLUMN token_limit INTEGER;
  `,
  `
  -- "Ask when unsure" (spec 007, S62).
  -- \`outside_mark\` on a message is JSON text, or NULL: the first source of outside content of the
  -- turn that started or made the message, when that turn held outside content. A fork of a chat
  -- keeps the mark of the place only when its copy holds such a message. It syncs with the message
  -- (spec 019), as \`program_mark\` does. The place keeps its own \`outside_mark\` (see above): from
  -- now on it holds any outside content that a turn gave, with a flag for the program mark.
  ALTER TABLE message ADD COLUMN outside_mark TEXT;
  ALTER TABLE channel_message ADD COLUMN outside_mark TEXT;
  -- The check of a step in the action log. \`check_reason\` is NULL when the step did not go to the
  -- check, 'allowed' when the check was sure, and a reason of the check ('unsure', 'timeout',
  -- 'network_error', 'service_error', 'unreadable', 'not_set_up') when the check sent the step to
  -- the user. \`check_probability\` is the chance of "The user asked for this", or NULL. The log
  -- stays on this computer and does not sync.
  ALTER TABLE action_log ADD COLUMN check_reason TEXT;
  ALTER TABLE action_log ADD COLUMN check_probability REAL;
  -- A routine that an agent file made counts its prompt as words of the user only after the user
  -- saved the routine form once (spec 007, 009): 1 until then. It syncs with the routine.
  ALTER TABLE routine ADD COLUMN unsaved_import INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- "Trust read-only marks" (spec 018, S63): the switch of a connection. 0 (off) is the default.
  -- With 1, a call of a tool that carries the read-only mark is not a risky step outside a turn
  -- that holds outside content. The switch stays on this computer with the connection: sync (019)
  -- does not carry the table. An export keeps the column, and an import leaves it off (the import
  -- names its columns and does not read this one), like the review of tools.
  ALTER TABLE tool_connection ADD COLUMN trust_read_only INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- The handbook and the instructions of a channel (spec 002, 004, S66).
  -- \`read_handbook\` is the switch "Read the handbook" of an agent: 1 (on) is the default. It
  -- syncs with the agent (spec 019, the dirty trigger of the agent watches every column).
  ALTER TABLE agent ADD COLUMN read_handbook INTEGER NOT NULL DEFAULT 1;
  -- The instructions of a channel (up to 4000 characters, empty by default). They sync with the
  -- channel and an export keeps them (spec 004, 019, 014).
  ALTER TABLE channel ADD COLUMN instructions TEXT NOT NULL DEFAULT '';
  -- The handbook of a server is its newest version; the older ones are its history (the last 20
  -- stay). A server that has no row has an empty handbook. When two computers change it before
  -- they sync, both versions arrive and the newest one is the handbook, so the later change wins
  -- and the other text stays in the history (spec 019). The versions sync (kind "hversion") and an
  -- export keeps them with keys hidden (spec 014).
  CREATE TABLE handbook_version (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES server (id),
    text TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX handbook_version_server ON handbook_version (server_id, created_at);
  ${dirtyTriggers("handbook_version", "hversion", plainId)}
  `,
  `
  -- The memory check (spec 008, S64). The choice of an agent: 0 (off) is the default. It is a
  -- choice of one computer, like the other memory switches (spec 019): no dirty trigger is made
  -- here, and sync does not read the column.
  ALTER TABLE agent ADD COLUMN memory_check INTEGER NOT NULL DEFAULT 0;
  -- The turns that ended as done since the last check: their number is the count of the agent.
  -- A restart keeps the rows, so it keeps the count. The check reads these turns when it starts,
  -- and deletes the rows then. A task that sync brought from the other computer is not counted
  -- here: each computer counts its own turns. The rows are not part of an import.
  CREATE TABLE memory_check_turn (
    task_id TEXT PRIMARY KEY REFERENCES task (id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agent (id) ON DELETE CASCADE,
    at INTEGER NOT NULL
  );
  CREATE INDEX memory_check_turn_agent ON memory_check_turn (agent_id, at);
  -- 1 for a proposal that a memory check made (the tab shows "From a memory check").
  ALTER TABLE memory_proposal ADD COLUMN from_check INTEGER NOT NULL DEFAULT 0;
  `,
  `
  -- Channel notes (spec 008, 004, S65). A memory item may name one channel: it is then a note
  -- that the agent reads only in turns of that channel. NULL is a general item. There is no
  -- foreign key: the delete of a channel removes its notes in code, so that each one gets a
  -- history row, and a channel that sync removes takes its notes with it. The column syncs
  -- with the item (the dirty trigger of the table watches every column).
  ALTER TABLE memory ADD COLUMN channel_id TEXT;
  CREATE INDEX memory_channel ON memory (channel_id);
  -- The channel that a proposal would make its item a note of, or NULL for a general item. It is
  -- not the place where the proposal was made. Proposals do not sync (spec 019).
  ALTER TABLE memory_proposal ADD COLUMN channel_id TEXT;
  -- The channel of the item before and after a change, with the name of the channel at that
  -- time (the channel may be gone later). A move is a change of kind 'moved'. The actor
  -- 'channel_deleted' is the delete of a channel. History does not sync.
  ALTER TABLE memory_history ADD COLUMN channel_before TEXT;
  ALTER TABLE memory_history ADD COLUMN channel_after TEXT;
  ALTER TABLE memory_history ADD COLUMN channel_name_before TEXT;
  ALTER TABLE memory_history ADD COLUMN channel_name_after TEXT;
  `,
  `
  -- "The lead answers questions" (spec 004, S74): a setting of the channel, on (1) by default. A
  -- question of a member in a part goes to the lead first. It syncs with the channel (spec 019):
  -- the dirty trigger of the channel already watches every column.
  ALTER TABLE channel ADD COLUMN lead_answers INTEGER NOT NULL DEFAULT 1;
  `,
]
