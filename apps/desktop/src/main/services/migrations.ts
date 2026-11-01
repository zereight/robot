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
]
