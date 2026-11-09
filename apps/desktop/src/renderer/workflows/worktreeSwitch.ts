/**
 * The state of the switch "Work in a new worktree" (spec 007, "New worktree"). A folder outside
 * Git cannot turn it on: the switch is off and a muted line says so. A switch that is already on
 * can always be turned off. The switch is read-only while a run works.
 */
export const worktreeSwitch = (workflow: {
  readonly newWorktree: boolean
  readonly folderInGit: boolean
  readonly running: boolean
}) => ({
  disabled: workflow.running || (!workflow.folderInGit && !workflow.newWorktree),
  showNotGit: !workflow.folderInGit,
})
