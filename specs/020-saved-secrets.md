# 020 Saved secrets

## Purpose

An agent can use an API key or a password for a web service, and the model never sees the value.
The user types the value once, in a protected field, and the app adds it to each request.

## Concepts

- **Saved secret**: a name, the agent that it belongs to, an origin, a way to send it, the date it
  was saved, and the date it was last used. The value is in the system keychain (see 014), never
  in the database.
  - The name holds 1 to 40 characters: letters, digits, `-` and `_`. It is unique for its agent,
    and the check ignores case.
  - The origin is the scheme, the host and the port of the service, for example
    `https://api.example.com`. It uses https. See "Rules" for addresses on this computer and on
    the local network.
  - The way to send it is one of: a bearer token, a header with a name that the agent gives, or a
    basic sign-in with a user name that the agent gives. For a basic sign-in the value is the
    password.
- **Protected card**: a card in the chat with a field for the value. See "Flows".

## Flows

1. Ask: the agent calls the tool "ask for a secret" with a name, a short label, the reason, the
   origin and the way to send it. The chat shows a protected card. The card shows the reason, the
   origin in large text, the way to send it, a hidden field, Save and Cancel.
   - Save puts the value in the keychain. The field is cleared when the save starts. The card
     then shows "Saved". The agent gets the name, not the value.
   - Cancel: the card shows "Cancelled", and the agent gets that answer.
   - When a secret with the same name and the same origin and way to send it exists, no card
     shows. The agent gets the name. With the choice "replace", a new card shows and the new
     value replaces the old one.
   - A secret with the same name and another origin or way to send it is refused. The user must
     delete the old one first.
2. Use: the agent calls the tool "request with a secret" with the name, an address, a method (GET,
   POST, PUT, PATCH or DELETE), and for methods other than GET an optional body (JSON, form, or
   plain text) and optional extra headers. The app adds the value and sends the request.
   - The approval rules of 007 apply. Methods other than GET are risky steps. A rule matches the
     name of the secret and a method, or "any method".
   - The card in the chat shows the name of the secret, the method and the address. It never
     shows the value.
3. Forget: the agent calls the tool "forget a secret" with a name. The value leaves the keychain.
   A request that has already started can end.
4. Manage: settings, Permissions, has the part "Saved secrets". It lists each secret: the face
   and name of the agent, the name, the origin, the way to send it, the date it was saved, and the
   date it was last used. The user can filter by agent, replace a value (a hidden field), and
   delete a secret after a confirm. The page never shows a value.

## States

- No saved secrets: the part shows one muted line that says what a saved secret is.
- A secret whose value is missing (for example after an import, see 014) shows "Value missing".
  A request with it fails with that reason until the user replaces the value.
- A protected card that waits counts as a question for the island and the notifications (see
  015). The island has no field: a click opens the chat.
- On a linked device (012), the protected card shows "Answer this on NAME", with the name of the
  computer that runs the agent. A value never goes over a device link.

## Rules

- The model has no tool that reads a value. The app never puts a value into a shell command, a
  file, an environment value, a browser page, a message, a log, the action log, or an export.
- The address of a request must have the same scheme, host and port as the origin of the secret.
  Else the request is refused with the reason.
- The app does not follow a redirect. A redirect ends the request with its status and the new
  address, and the agent can make a new request.
- The app refuses an address that leads to a link-local address or to a cloud metadata address.
- An address on this computer (`127.0.0.1`, `localhost`, `::1`) or on the local network may use
  http, and is allowed at all, only when the switch "Allow saved secrets on this computer and the
  local network" is on. It is in settings, Permissions, and it is off by default. The switch says
  that such a request travels without encryption on the network.
- A request has a time limit of 30 seconds. The app reads at most 1 MB of the answer. The agent
  gets the status, the content type, and at most 20000 characters of the body. It gets no
  headers of the answer. When the body was cut, the agent is told so.
- Before the agent gets the answer, the app replaces the value with `[redacted]` in it, also in
  its common encodings (base64, URL encoding and hex). The service still receives the value. The
  user must pick services that they trust.
- The answer is outside content (see 007).
- An agent holds at most 100 saved secrets. A value holds at most 16384 characters.
- A secret belongs to the agent that asked for it. Other agents cannot use it. A duplicate of the
  agent (002) gets no secrets. Deleting an agent deletes its secrets.
- An export holds the name, the agent, the origin and the way to send each secret, not the value.
  After an import, each secret shows "Value missing".
- Saved secrets do not sync (019). The values are in the keychain of one computer. The list on
  the other computer does not show them.
- These tools are for agents whose model comes from an API provider (see 006), as connections are
  (see 018).

## Out of scope

- A sign-in through a browser window, and tokens that the app must refresh.
- Requests that must be signed, or that need more than one secret.
- A secret in a shell command or in an environment value.

## Acceptance

All checks use a small test web service, written for the test.

- The agent asks for the secret `test_api` for `https://127.0.0.1:PORT` with a bearer token, and
  the switch for this computer is on. The card shows the origin. Save a value: the database file,
  the logs, the chat and an export hold no clear text of it.
- A GET request with the secret: the test service gets the header with the value. The agent gets
  the body.
- The test service sends the value back in its body, as plain text and as base64: the agent gets
  `[redacted]` in both places.
- A request with the secret to another port: the app refuses it.
- The test service answers with a redirect: the app does not follow it, and the agent gets the
  status and the new address.
- With the switch for this computer off, a request to `127.0.0.1` is refused with the reason.
- A POST at "Ask for risky steps" shows an approval card with the name, the method and the
  address. "Always allow for this agent" saves a rule. The next POST runs with no question.
- Ask for the same secret again: no card shows. Ask with "replace": a card shows.
- Delete the secret in settings: the next request fails, and the keychain no longer holds it.
- Export, then import into an empty app: the secret shows "Value missing".
- A test service that waits 40 seconds: the request fails after 30 seconds.
