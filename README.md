# ROBot

ROBot (Rapid Open Bot) is a desktop and mobile app where you work with AI agents the way you work
with people on a chat server. Each agent has a face, a name, a workspace and a memory. You talk to
one agent in a direct chat, or put several agents in a channel and give them a job together.

## Status

This repository is a clean-room implementation. It starts from an empty tree. Read
[CLEANROOM.md](CLEANROOM.md) before you add anything.

Work goes in this order:

1. Behaviour specs in [`specs/`](specs/README.md).
2. Implementation from the specs only.

## Stack

- Desktop: Electron, SolidJS, Effect, Bun
- Mobile: Expo (React Native)

## Build and release

`bun install`, then `bun run dev` to run the desktop app, or `bun run dist` to package it.
Releases are described in [docs/release.md](docs/release.md).

## License

[MIT](LICENSE). Dependencies must use licenses that are compatible with MIT.
