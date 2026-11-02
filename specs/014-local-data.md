# 014 Local data, privacy and export

## Purpose

The user owns their data. It lives on their computer, it is easy to back up, and nothing leaks.

## Rules

- One local database file holds servers, agents, conversations, tasks, routines, workflows,
  memory and settings. Attachments are files next to it.
- The data folder is in the system's app data location under the name "ROBot".
- The database is the source of truth. Nothing remote is a cache of it.
- The app never sends conversation content, files, or commands anywhere except the model provider
  an agent uses and the pages an agent visits. There is one more exception, and it is off by
  default: the decision model that the user sets up (see 013). When the user sets it up:
  - For a channel pick (see 004), the app sends to it the channel name and topic, the last few
    messages of the channel, the job, and the name and role line of each member.
  - For the fast path of computer use (see 007), when the user turns it on, the app sends the goal
    that the agent wrote and the role, label and value of each control of one window. It sends no
    screenshot. It sends no value of a secret control.
  - A local server on this computer is the only choice that sends nothing off the computer.
- The app sends no usage events and no failure reports. It has no analytics at all.
- The app does not ask other sites for icons or other assets. Every request goes to a service that
  the user set up or to a page that an agent visits.
- Secrets (keys, tokens, secret values of environment variables) are in the system keychain. Logs
  and exports redact anything that looks like a secret.

## Logs

- Logs are files in a logs folder inside the data folder. The user opens the folder from settings
  (see 013). Each log has a size limit; the oldest lines go first.
- There is one log for each of these areas: channels, browser, and workflows.
  - Channels: one line for each answer of the decision model (see 004). It holds no job text and
    no key.
  - Browser: failed tool calls, Stop requests with their result, warnings, and live view input
    that the app dropped or refused (see 007).
  - Workflows: retries, final failures of model steps and conditions (see 010).
- A log line never holds a secret, a key, or the text of a message.

## Export and backup

- Export: one archive with the database, attachments, and a readme of the format. Secrets are
  not included.
- Import of a ROBot export into an empty app restores everything except secrets.

## Acceptance

- Run a channel job with the fast pick set up. The channels log holds one line for it. A search
  of the log finds neither the job text nor the key.
- After an export, searching the archive for a stored key finds nothing.
- Copy the data folder to a new computer, start the app: all agents and history are there; the
  providers ask to sign in again.
