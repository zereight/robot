# 014 Local data, privacy and export

## Purpose

The user owns their data. It lives on their computer, it is easy to back up, and nothing leaks.

## Rules

- One local database file holds servers, agents, conversations, tasks, routines, workflows,
  memory and settings. Attachments are files next to it.
- The data folder is in the system's app data location under the name "ROBot".
- The database is the source of truth. Nothing remote is a cache of it.
- The app never sends conversation content, files, or commands anywhere except the model provider
  an agent uses and the pages an agent visits.
- No analytics that contain content. Crash reports, if the user turns them on, contain no
  messages, paths with user names, or secrets.
- Secrets (keys, tokens) are in the system keychain. Logs and exports redact anything that looks
  like a secret.

## Export and backup

- Export: one archive with the database, attachments, and a readme of the format. Secrets are
  not included.
- Import of a ROBot export into an empty app restores everything except secrets.

## Acceptance

- After an export, searching the archive for a stored key finds nothing.
- Copy the data folder to a new computer, start the app: all agents and history are there; the
  providers ask to sign in again.
