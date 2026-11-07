/**
 * The schema of the local database (spec 014).
 *
 * The workflow is the main object (spec 000, 010): a graph of nodes, one responsible document with
 * its history (002), one chat (003), and one memory (008). The agent, the organization chart and
 * the routine are not objects any more. The old schema is not moved to this one (decision 16 of
 * `docs/proposal-workflow-first.md`): a database from before is erased on the first start (see
 * `Database.ts`, `LEGACY_VERSION`).
 *
 * Never change a shipped entry; add a new one. The index + 1 is stored as the database user version.
 */
export const migrations: readonly string[] = [
  `
  -- The app: settings and the state of the window.
  CREATE TABLE setting (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE ui_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE server (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    position INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  -- Model accounts (spec 006).
  CREATE TABLE provider_account (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    off INTEGER NOT NULL DEFAULT 0,
    sign_in TEXT
  );
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

  -- Skills belong to the server of the user, not to one workflow (spec 017).
  CREATE TABLE skill (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES server (id),
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    instructions TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX skill_name ON skill (server_id, name_key);

  -- Connections to outside tools (spec 018).
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
    enabled INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'untested',
    failure TEXT,
    tools TEXT NOT NULL DEFAULT '[]',
    tools_more INTEGER NOT NULL DEFAULT 0,
    tools_off TEXT NOT NULL DEFAULT '[]',
    reviewed TEXT NOT NULL DEFAULT '[]',
    review_adopt INTEGER NOT NULL DEFAULT 0,
    trust_read_only INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX tool_connection_name ON tool_connection (server_id, name_key);

  -- Browser data that a workflow can share (spec 007).
  CREATE TABLE browser_profile (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    purpose TEXT
  );

  -- Linked computers and phones (spec 012).
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
    last_seen INTEGER,
    can_change INTEGER NOT NULL DEFAULT 0
  );
  `,
  `
  -- The workflow (spec 010): a name, a graph of nodes, one responsible document (002), one folder
  -- and one permission level (007), one chat (003), and one memory (008).
  -- The trigger and the on or off state of a workflow are not stored yet: the rules of the
  -- trigger are not decided (docs/spec-questions.md, rows for 010).
  CREATE TABLE workflow (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES server (id),
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    -- The responsible document (spec 002): 0 to 20000 characters. Empty is valid.
    document TEXT NOT NULL DEFAULT '',
    -- The folder of the workflow (spec 007). Only the user changes it.
    folder TEXT NOT NULL,
    -- The permission level of the workflow (spec 007). Only the user changes it.
    permission TEXT NOT NULL DEFAULT 'ask_risky' CHECK (permission IN ('read_only', 'ask_all', 'ask_risky', 'ask_unsure', 'full')),
    -- The switch "Self-improvement" (spec 002). On by default.
    self_improvement INTEGER NOT NULL DEFAULT 1 CHECK (self_improvement IN (0, 1)),
    -- Computer use (spec 007): a switch of the workflow, on by default.
    computer_use INTEGER NOT NULL DEFAULT 1 CHECK (computer_use IN (0, 1)),
    -- Memory (spec 008): on or off; "ask" (Ask me first, the default) or "now" (Save at once); the
    -- memory check, off by default, with the count of done tasks of text nodes since the last check.
    memory_enabled INTEGER NOT NULL DEFAULT 1 CHECK (memory_enabled IN (0, 1)),
    memory_mode TEXT NOT NULL DEFAULT 'ask' CHECK (memory_mode IN ('ask', 'now')),
    memory_check INTEGER NOT NULL DEFAULT 0 CHECK (memory_check IN (0, 1)),
    memory_check_count INTEGER NOT NULL DEFAULT 0,
    -- The marks of outside content and of a sensitive read in the chat (spec 007).
    outside_mark TEXT,
    sensitive_mark TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  -- The name of a workflow is unique on a server, ignoring case (spec 010, 019).
  CREATE UNIQUE INDEX workflow_name ON workflow (server_id, name_key);

  -- A node (spec 010). 'text': a prompt, a provider, a model and a reasoning level. 'decision': a
  -- question, a threshold and a list of options (workflow_option), and no reasoning level.
  -- "number" is the place of the node in the list of nodes, from 1; the app keeps it with no gap.
  CREATE TABLE workflow_node (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflow (id) ON DELETE CASCADE,
    number INTEGER NOT NULL CHECK (number >= 1),
    kind TEXT NOT NULL CHECK (kind IN ('text', 'decision')),
    name TEXT NOT NULL,
    prompt TEXT NOT NULL DEFAULT '',
    -- A node that names no account takes the preferred one (the rule is not decided, 010).
    account_id TEXT,
    model TEXT,
    effort TEXT,
    -- A stricter level than the workflow, never a looser one (spec 010). NULL: the level of the workflow.
    permission TEXT CHECK (permission IS NULL OR permission IN ('read_only', 'ask_all', 'ask_risky', 'ask_unsure', 'full')),
    continue_on_failure INTEGER NOT NULL DEFAULT 0 CHECK (continue_on_failure IN (0, 1)),
    -- A decision node (spec 010): the question and the threshold (0.9 at the start).
    question TEXT NOT NULL DEFAULT '',
    threshold REAL NOT NULL DEFAULT 0.9 CHECK (threshold >= 0 AND threshold <= 1),
    -- The place on the canvas. Moving a node does not change its number.
    x REAL NOT NULL DEFAULT 0,
    y REAL NOT NULL DEFAULT 0
  );
  CREATE INDEX workflow_node_workflow ON workflow_node (workflow_id, number);

  -- An option of a decision node: one outgoing connection for each option.
  CREATE TABLE workflow_option (
    id TEXT PRIMARY KEY,
    node_id TEXT NOT NULL REFERENCES workflow_node (id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    label TEXT NOT NULL
  );
  CREATE INDEX workflow_option_node ON workflow_option (node_id, position);

  -- A connection: a line from the output of one node to the input of another node. The output of a
  -- decision node is one of its options. A connection never joins a node to itself.
  CREATE TABLE workflow_connection (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflow (id) ON DELETE CASCADE,
    from_node_id TEXT NOT NULL REFERENCES workflow_node (id) ON DELETE CASCADE,
    to_node_id TEXT NOT NULL REFERENCES workflow_node (id) ON DELETE CASCADE,
    option_id TEXT REFERENCES workflow_option (id) ON DELETE CASCADE,
    CHECK (from_node_id <> to_node_id)
  );
  CREATE INDEX workflow_connection_workflow ON workflow_connection (workflow_id);
  -- An option has one outgoing connection (spec 010).
  CREATE UNIQUE INDEX workflow_connection_option ON workflow_connection (option_id) WHERE option_id IS NOT NULL;

  -- A version of the graph: the graph as it was before a change that was saved (spec 010).
  -- "graph" is JSON with the nodes, the options and the connections.
  CREATE TABLE workflow_version (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflow (id) ON DELETE CASCADE,
    graph TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX workflow_version_workflow ON workflow_version (workflow_id, created_at);

  -- The history of the responsible document (spec 002): the old text, where the change came from
  -- ('editor', 'proposal', 'undo' or 'restore'), and the linked device for a change from one.
  CREATE TABLE document_version (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflow (id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    source TEXT NOT NULL,
    device TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX document_version_workflow ON document_version (workflow_id, created_at);

  -- The browser data of a workflow: a shared browser profile, or its own data when absent.
  CREATE TABLE workflow_browser (
    workflow_id TEXT PRIMARY KEY REFERENCES workflow (id) ON DELETE CASCADE,
    profile_id TEXT NOT NULL REFERENCES browser_profile (id) ON DELETE CASCADE
  );
  CREATE INDEX workflow_browser_profile ON workflow_browser (profile_id);
  `,
  `
  -- The chat of a workflow (spec 003): one chat for each workflow, with threads and forks.
  -- A message with no thread belongs to the main thread.
  CREATE TABLE chat_thread (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflow (id) ON DELETE CASCADE,
    title TEXT,
    titled INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 0,
    archived_at INTEGER,
    fork_thread_id TEXT,
    fork_message_id TEXT,
    outside_mark TEXT,
    sensitive_mark TEXT
  );
  CREATE INDEX chat_thread_workflow ON chat_thread (workflow_id, created_at);
  CREATE TABLE chat_thread_read (
    thread_id TEXT PRIMARY KEY REFERENCES chat_thread (id) ON DELETE CASCADE,
    at INTEGER NOT NULL
  );
  CREATE TABLE chat_message (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflow (id) ON DELETE CASCADE,
    thread_id TEXT REFERENCES chat_thread (id) ON DELETE CASCADE,
    -- 'user', 'assistant' (the responsible document) or 'app'.
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
    context TEXT,
    origin TEXT,
    joined_to TEXT,
    program_mark TEXT,
    outside_mark TEXT,
    created_at INTEGER NOT NULL,
    finished_at INTEGER,
    edited_at INTEGER,
    read_at INTEGER
  );
  CREATE INDEX chat_message_workflow ON chat_message (workflow_id, created_at);
  CREATE INDEX chat_message_thread ON chat_message (thread_id, created_at);

  -- A run of a workflow (spec 010) and a task, one execution of one node (spec 005).
  -- 'state' of a run follows its tasks. The names of the states of a run are not decided
  -- (docs/spec-questions.md, rows for 005), so no CHECK holds them here.
  CREATE TABLE run (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflow (id) ON DELETE CASCADE,
    state TEXT NOT NULL,
    -- 'hand', 'chat' or 'schedule' (spec 005, "Tasks page").
    source TEXT NOT NULL,
    trigger_text TEXT NOT NULL DEFAULT '',
    reason TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER
  );
  CREATE INDEX run_workflow ON run (workflow_id, started_at);
  CREATE TABLE task (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES run (id) ON DELETE CASCADE,
    workflow_id TEXT NOT NULL REFERENCES workflow (id) ON DELETE CASCADE,
    -- The node as it was when the task was made. The node may be gone later.
    node_id TEXT REFERENCES workflow_node (id) ON DELETE SET NULL,
    node_name TEXT NOT NULL,
    node_number INTEGER NOT NULL,
    retry_of TEXT,
    input TEXT NOT NULL DEFAULT '',
    result TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL,
    error_code TEXT,
    error_detail TEXT,
    -- How far the turn went: 'not_sent', 'sent' or 'started' (spec 005).
    progress TEXT NOT NULL DEFAULT 'not_sent',
    -- A decision node: the probability of each option as JSON, and the option that was taken.
    decision TEXT,
    option_id TEXT,
    kept_going INTEGER NOT NULL DEFAULT 0,
    -- The moments and the times (spec 005). 'ended_at': the turn ended, 'ended_as' says how.
    -- 'finished_at': the task reached a final state.
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    first_reply_at INTEGER,
    ended_at INTEGER,
    ended_as TEXT,
    finished_at INTEGER,
    -- Usage (spec 005). NULL: the provider reported none. It is shown as "—", never as 0.
    input_tokens INTEGER,
    output_tokens INTEGER,
    cached_tokens INTEGER,
    cost_micros INTEGER
  );
  CREATE INDEX task_run ON task (run_id, created_at);
  CREATE INDEX task_workflow ON task (workflow_id, created_at);

  -- The memory of a workflow (spec 008) and the history of its changes.
  CREATE TABLE memory (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflow (id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    -- 'user', 'node' or 'proposal' (spec 008, "Memory item").
    source TEXT NOT NULL,
    task_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX memory_workflow ON memory (workflow_id, created_at);
  CREATE TABLE memory_history (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflow (id) ON DELETE CASCADE,
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
  CREATE INDEX memory_history_workflow ON memory_history (workflow_id, at);
  `,
  `
  -- Permission rules (spec 007): for one workflow, or for all workflows (NULL).
  CREATE TABLE permission_rule (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL,
    workflow_id TEXT REFERENCES workflow (id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    match_text TEXT NOT NULL,
    detail TEXT,
    decision TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX permission_rule_workflow ON permission_rule (workflow_id);
  CREATE INDEX permission_rule_server ON permission_rule (server_id, created_at);

  -- The action log (spec 007).
  CREATE TABLE action_log (
    id TEXT PRIMARY KEY,
    at INTEGER NOT NULL,
    workflow_id TEXT NOT NULL,
    workflow_name TEXT NOT NULL,
    -- The node of the task that made the step, as it was then (spec 007). NULL for a step with no task.
    node_name TEXT,
    node_number INTEGER,
    kind TEXT NOT NULL,
    target TEXT NOT NULL,
    decided_by TEXT NOT NULL,
    result TEXT NOT NULL,
    task_id TEXT,
    outside TEXT,
    access TEXT,
    sensitive TEXT,
    rule_id TEXT,
    rule_kind TEXT,
    rule_text TEXT,
    rule_detail TEXT,
    check_reason TEXT,
    check_probability REAL
  );
  CREATE INDEX action_log_at ON action_log (at);
  CREATE INDEX action_log_task ON action_log (task_id, at);

  -- Saved secrets (spec 020) belong to a workflow. The values are in the keychain: when a
  -- workflow is deleted, the references go to saved_secret_drop and the app removes the values.
  CREATE TABLE saved_secret (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    origin TEXT NOT NULL,
    auth TEXT NOT NULL,
    value_ref TEXT,
    saved_at INTEGER NOT NULL,
    last_used_at INTEGER,
    UNIQUE (workflow_id, name_key)
  );
  CREATE TABLE saved_secret_drop (
    value_ref TEXT PRIMARY KEY
  ) WITHOUT ROWID;
  CREATE TRIGGER saved_secret_workflow_gone AFTER DELETE ON workflow BEGIN
    INSERT OR IGNORE INTO saved_secret_drop (value_ref)
      SELECT value_ref FROM saved_secret WHERE workflow_id = OLD.id AND value_ref IS NOT NULL;
    DELETE FROM saved_secret WHERE workflow_id = OLD.id;
  END;
  `,
  `
  -- Feedback of the user on the results of a run (spec 003, "Feedback"). A node that starts after
  -- the feedback reads it with its input. The text is not part of the file of the workflow.
  CREATE TABLE run_feedback (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES run (id) ON DELETE CASCADE,
    workflow_id TEXT NOT NULL REFERENCES workflow (id) ON DELETE CASCADE,
    -- The number of the node that the feedback names. NULL: the run as a whole.
    node_number INTEGER,
    text TEXT NOT NULL,
    message_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX run_feedback_run ON run_feedback (run_id, created_at);
  `,
  `
  -- The account and the model that answer in the chat of a workflow. The choice stays between
  -- turns. It changes when the account or the model is gone, or when the user picks another one.
  -- It is local to this computer and is not part of the file of the workflow.
  CREATE TABLE workflow_chat_model (
    workflow_id TEXT PRIMARY KEY REFERENCES workflow (id) ON DELETE CASCADE,
    account_id TEXT NOT NULL,
    model TEXT NOT NULL,
    effort TEXT
  );
  `,
  `
  -- The engine of the runs (spec 010, 005, 007).
  -- A run keeps the code of its reason, so the window can translate it.
  ALTER TABLE run ADD COLUMN reason_code TEXT;
  -- A task keeps the marks of outside content, of the program and of a sensitive read (spec 007),
  -- and the number of its steps (spec 005, "Limits of a task").
  ALTER TABLE task ADD COLUMN outside_mark TEXT;
  ALTER TABLE task ADD COLUMN program_mark INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE task ADD COLUMN sensitive_mark TEXT;
  ALTER TABLE task ADD COLUMN steps INTEGER NOT NULL DEFAULT 0;
  -- The numbers of the text nodes that got a feedback with their input, as JSON.
  ALTER TABLE run_feedback ADD COLUMN nodes TEXT NOT NULL DEFAULT '[]';
  -- A card in the chat that waits for the user, or that the user answered (spec 003, 007). A card of
  -- a node has a task; a card of a turn of the chat (guarded feedback) has none.
  CREATE TABLE task_card (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflow (id) ON DELETE CASCADE,
    run_id TEXT REFERENCES run (id) ON DELETE CASCADE,
    task_id TEXT REFERENCES task (id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    -- The data of the card as JSON: summary, step, choices, options, marks.
    payload TEXT NOT NULL,
    answer TEXT,
    answered_in_chat INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    answered_at INTEGER
  );
  CREATE INDEX task_card_workflow ON task_card (workflow_id, created_at);
  `,
  `
  -- The linked device that answered the card of a step, named in the entry (spec 012). NULL when
  -- the user answered at this computer, or when no card decided the step.
  ALTER TABLE action_log ADD COLUMN device TEXT;
  `,
  `
  -- The result of the check of the graph of a workflow (spec 010, "Check"). "graph_key" names the
  -- graph that was checked: a result is valid only while the graph has the same key. "outcome" is
  -- JSON. The result stays on this computer and does not sync (spec 010, "Data").
  CREATE TABLE workflow_check (
    workflow_id TEXT PRIMARY KEY REFERENCES workflow (id) ON DELETE CASCADE,
    graph_key TEXT NOT NULL,
    outcome TEXT NOT NULL,
    checked_at INTEGER NOT NULL
  );
  `,
  `
  -- Self-improvement (spec 002): the proposals of a workflow and its change log. A row that waits is
  -- a proposal. A row of another state is the change log. Neither syncs (spec 002, "Data"); they go
  -- with the workflow when it is deleted.
  -- "kind": 'document', 'prompt', 'graph' or 'memory'. "node_*": the node of a prompt change, as it
  -- was. "source_kind": 'run', 'chat' or 'check'; "source_id": the run or the message; "task_id": the
  -- task of a node that suggested a memory item. "outside": the first source of outside content, as
  -- JSON, or NULL. "old_text" and "new_text": the text before and after, or the fact of a memory item.
  -- "graph": the new graph as JSON, for a graph change. "check": the result of the check of that graph.
  -- "base_key" is the fingerprint of the target when the proposal was made: a proposal whose target
  -- changed after is stale. "after_key" is the fingerprint after the change: Undo is on only while
  -- the target still has it. "applied": JSON with the version or the history row that the change
  -- made, which Undo reads.
  CREATE TABLE proposal (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL REFERENCES workflow (id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('document', 'prompt', 'graph', 'memory')),
    node_id TEXT,
    node_number INTEGER,
    node_name TEXT,
    reason TEXT NOT NULL DEFAULT '',
    source_kind TEXT NOT NULL CHECK (source_kind IN ('run', 'chat', 'check')),
    source_id TEXT,
    task_id TEXT,
    outside TEXT,
    state TEXT NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting', 'applied', 'rejected', 'failed', 'undone')),
    state_reason TEXT,
    old_text TEXT,
    new_text TEXT,
    graph TEXT,
    check_outcome TEXT,
    base_key TEXT,
    after_key TEXT,
    applied TEXT,
    created_at INTEGER NOT NULL,
    answered_at INTEGER,
    undone_at INTEGER
  );
  CREATE INDEX proposal_workflow ON proposal (workflow_id, state, created_at);
  CREATE INDEX proposal_source ON proposal (workflow_id, source_kind, source_id);
  CREATE INDEX proposal_task ON proposal (task_id);
  -- The items that a task saved, for the run view (spec 008, "Flows", 1).
  CREATE INDEX memory_task ON memory (task_id);
  `,
  `
  -- Who asked for a change through the chat (spec 012, "Record"; "No switch"). A message of the
  -- user keeps the linked device that sent it: NULL means the window of this computer. The turn
  -- reads these rows at each tool call, so it knows for whom it acts, also after a retry, a queue
  -- or a restart. The switch itself is read from the device at each call, never stored here.
  ALTER TABLE chat_message ADD COLUMN actor_id TEXT;
  ALTER TABLE chat_message ADD COLUMN actor_name TEXT;
  -- The linked device that made a change of the graph through the chat ("Last changed by
  -- <device name>"), and the linked device that started a run ("Started by <device name>"). NULL
  -- means the user at this computer.
  ALTER TABLE workflow_version ADD COLUMN device TEXT;
  ALTER TABLE run ADD COLUMN device TEXT;
  `,
  `
  -- File claims in shared folders (spec 025). A task holds a claim on a file that its text node
  -- changed. 'path' is the real path; 'path_key' is the same path as the file system of the folder
  -- compares names (folded to lower case on a system that ignores case). A claim ends when its
  -- task is final, and every claim ends at the start of the app: after a restart no task works.
  -- The claims stay on this computer. They do not sync and no export holds them.
  CREATE TABLE file_claim (
    task_id TEXT NOT NULL,
    workflow_id TEXT NOT NULL REFERENCES workflow (id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    path_key TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (task_id, path_key)
  ) WITHOUT ROWID;
  CREATE INDEX file_claim_key ON file_claim (path_key);
  CREATE INDEX file_claim_workflow ON file_claim (workflow_id, at);
  -- The workflow that held the file, for a step that a claim refused (spec 025, "States").
  ALTER TABLE action_log ADD COLUMN holder TEXT;
  `,
  `
  -- "Mark as unread" (spec 003). The place that the user marked in the chat of a workflow: the
  -- message, and its time for the case that an edit removed the message. The unread replies are
  -- that reply and every later reply. The row goes when the chat shows its latest message. It stays
  -- on this computer. Natural unread counts (a reply that ends while the chat is shut) are not kept
  -- here (docs/spec-questions.md, rows for B4).
  CREATE TABLE chat_unread (
    workflow_id TEXT PRIMARY KEY REFERENCES workflow (id) ON DELETE CASCADE,
    message_id TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  `,
  `
  -- The backup model of a text node (spec 006, "Backup model"): an account, a model and a reasoning
  -- level. All three are NULL when the node has none. The choice is a field of the node, so it
  -- belongs to the graph and to the versions of the graph.
  ALTER TABLE workflow_node ADD COLUMN backup_account_id TEXT;
  ALTER TABLE workflow_node ADD COLUMN backup_model TEXT;
  ALTER TABLE workflow_node ADD COLUMN backup_effort TEXT;
  -- The hold of the main model of a node (spec 006). It is a state of this computer: sync (019) does
  -- not carry it and an export does not hold it. It has no foreign key on purpose: a change of the
  -- whole graph writes the nodes again, and the hold of a node that stays must stay. The backup that
  -- was on the node when the hold began is kept, so a hold does not pass to another backup. So is
  -- the main choice that failed: a hold is of that main model, and it does not count when the node
  -- names another one. The row of a workflow that is deleted leaves with the workflow.
  CREATE TABLE model_hold (
    node_id TEXT PRIMARY KEY,
    ends_at INTEGER NOT NULL,
    -- 1 after "Use <main model> now": the hold no longer counts.
    released INTEGER NOT NULL DEFAULT 0 CHECK (released IN (0, 1)),
    main_account_id TEXT NOT NULL,
    main_model TEXT NOT NULL,
    main_effort TEXT,
    backup_account_id TEXT NOT NULL,
    backup_model TEXT NOT NULL,
    backup_effort TEXT
  );
  -- The muted line "<main model> reached its limit. <backup model> goes on." of a task (spec 006).
  ALTER TABLE task ADD COLUMN backup_note TEXT;
  -- The tokens of a task for the model that made them, when the backup model went on (spec 006: the
  -- usage page counts the tokens for the model that made them). NULL: the provider reported none.
  CREATE TABLE task_usage (
    task_id TEXT NOT NULL REFERENCES task (id) ON DELETE CASCADE,
    account_id TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cached_tokens INTEGER,
    cost_micros INTEGER,
    PRIMARY KEY (task_id, account_id, model)
  );
  `,
  `
  -- The workflows that may use a connection (spec 018, "Concepts"). 'all' is "All workflows"; the
  -- other value 'workflows' is a list, kept in the table below. The default is the list, so a row
  -- with no scope set is used by no workflow (fail closed). A deleted workflow leaves every list
  -- through the cascade.
  ALTER TABLE tool_connection ADD COLUMN scope TEXT NOT NULL DEFAULT 'workflows';
  CREATE TABLE tool_connection_workflow (
    connection_id TEXT NOT NULL REFERENCES tool_connection (id) ON DELETE CASCADE,
    workflow_id TEXT NOT NULL REFERENCES workflow (id) ON DELETE CASCADE,
    PRIMARY KEY (connection_id, workflow_id)
  ) WITHOUT ROWID;
  CREATE INDEX tool_connection_workflow_workflow ON tool_connection_workflow (workflow_id);
  -- The notice lines and the tool lines of the connections that a task used (spec 018, "States"):
  -- JSON text, or NULL.
  ALTER TABLE task ADD COLUMN connection_notes TEXT;
  `,
  `
  -- The use of the context after a reply (spec 003, "Context meter"): the tokens that the last
  -- request of the turn read, and the tokens of the answer. NULL when the provider did not report
  -- them. The meter and the automatic compact read it from the last reply after the last compact.
  ALTER TABLE chat_message ADD COLUMN context_tokens INTEGER;
  `,
]
