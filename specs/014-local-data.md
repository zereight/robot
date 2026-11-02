# 014 Local data, privacy and export

## Purpose

The user owns their data. It lives on their computer, it is easy to back up, and nothing leaks.

## Rules

- One local database file holds servers, agents, conversations, tasks, routines, workflows,
  memory and settings. Attachments are files next to it.
- The data folder is in the system's app data location under the name "ROBot".
- The database is the source of truth. Nothing remote is a cache of it. Two computers that sync
  (016) each hold a full copy of the shared data. Both are sources of truth, and the rules of
  016 make them equal. A device that opens a linked server (012) keeps a local cache of recent
  messages for offline reading. The cache is deleted when the link ends and is never exported.
  The state of a sync (016) is not exported either. Backups that sync makes are in a "backups"
  folder in the data folder.
- The app never sends conversation content, files, or commands anywhere except the model provider
  an agent uses, the pages an agent visits, and the devices that the user linked (012). Traffic
  to a linked device is end-to-end encrypted.
- No analytics that contain content. Crash reports, if the user turns them on, contain no
  messages, paths with user names, or secrets.
- Secrets (keys, tokens) are in the system keychain. Logs and exports redact anything that looks
  like a secret. The keys of device links are secrets. A linked device never receives provider
  keys.

## Export and backup

- Export: one archive with the database, attachments, and a readme of the format. Secrets are
  not included.
- Import of a ROBot export into an empty app restores everything except secrets.

## Acceptance

- After an export, searching the archive for a stored key finds nothing.
- Copy the data folder to a new computer, start the app: all agents and history are there; the
  providers ask to sign in again.
