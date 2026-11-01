# 006 Providers

## Purpose

The user connects the model accounts they already have, and each agent uses one of them.

## Concepts

- **Provider**: a source of models. Two kinds:
  - **Agent runtimes**: coding agent programs from the model vendors (for example OpenAI Codex
    and Anthropic Claude Code). The app downloads the vendor's own runtime on request and the user
    signs in with the vendor's sign-in. These runtimes can read files and run commands themselves.
  - **API providers**: an HTTPS model API with a key (OpenAI-compatible, Anthropic, and a custom
    base URL).
- **Account**: one sign-in or key. A provider can have more than one account; the user names them.
- **Model list**: fetched from the provider when possible, with an effort level for models that
  support it.

## Flows

1. Connect: in settings, the user picks a provider and signs in or pastes a key. The app checks it
   with one small request and shows "Connected" or the error.
2. Choose: in the agent profile or the chat header, the user picks account, model and effort.
3. Switch: the user changes the model of an agent mid-history. The next turn uses it; the earlier
   turns stay.
4. Disconnect: removes the stored secret. Agents that used it show "Provider not connected".

## Rules

- Keys and tokens are stored in the system keychain, never in the database or logs.
- The app shows usage that the provider reports (tokens, cost if known, plan limits) on the usage
  page, per agent and per day.
- When a provider says a usage limit is reached, the turn fails with that reason and the time it
  resets, if known.

## Acceptance

- Connect an API key, pick a model, get a reply. Disconnect: the chat shows the reconnect button.
- No secret appears in the database file, the logs or an export.
