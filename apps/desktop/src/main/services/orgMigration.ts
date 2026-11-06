import type { DatabaseSync } from "node:sqlite"

// Organizations are removed from the app (spec 002, R1). Two old steps of the schema list in
// `migrations.ts` still name these functions, so they stay and do nothing. Slice C1 resets the
// schema and removes them.

/** Made organizations from channels. Organizations are removed, so it does nothing now. */
export const migrateChannelsToOrganizations = (_db: DatabaseSync): void => {}

/** Repaired the org lines after the migration. Organizations are removed, so it does nothing now. */
export const repairLinesAfterMigration = (_db: DatabaseSync): void => {}
