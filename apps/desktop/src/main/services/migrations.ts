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
]
