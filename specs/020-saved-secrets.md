# 020 Saved secrets

## Purpose

A text node of a workflow can use an API key or a password for a web service, and the model never
sees the value. The user types the value once, in a protected field, and the app adds it to each
request. Each workflow has its own vault: one place in the workflow where the user sees and
manages the API keys and passwords of that workflow.

## Concepts

- **Vault**: the saved secrets and the saved logins of one workflow, in the Secrets tab of the
  workflow view. The vault shows the name of the workflow. It shows no value.
- **Saved secret**: a name, the workflow that it belongs to, an origin, a way to send it, the date
  it was saved, and the date it was last used. The value is in the system keychain (see 014), never
  in the database.
  - The name holds 1 to 40 characters: letters, digits, `-` and `_`. It is unique for its
    workflow, and the check ignores case.
  - The origin is the scheme, the host and the port of the service, for example
    `https://api.example.com`. It uses https. See "Rules" for addresses on this computer and on
    the local network.
  - The way to send it is one of: a bearer token, a header with a name that the node gives, or a
    basic sign-in with a user name that the node gives. For a basic sign-in the value is the
    password.
- **Protected card**: a card in the chat of the workflow (003) with a field for the value. See
  "Flows".
- **Owner of a secret and of a login**: a secret or a login belongs to the workflow whose text
  node asked for it, or whose vault the user added it in. Other workflows cannot use it. The user
  sees and manages the secrets and logins of one workflow in its vault only (see "Flows", item 4).
  A decision node uses no secret (010). The responsible document has no tool for secrets (007).

## Flows

1. Ask: a text node calls the tool "ask for a secret" with a name, a short label, the reason, the
   origin and the way to send it. The chat of the workflow shows a protected card. The card shows
   the reason, the node, the origin in large text, the way to send it, a hidden field, Save and
   Cancel. The task waits for the user (005, "Waits for your answer").
   - Save puts the value in the keychain. The field is cleared when the save starts. The card
     then shows "Saved". The node gets the name, not the value.
   - Cancel: the card shows "Cancelled", and the node gets that answer.
   - When a secret with the same name and the same origin and way to send it exists, no card
     shows. The node gets the name. With the choice "replace", a new card shows and the new
     value replaces the old one.
   - A secret with the same name and another origin or way to send it is refused. The user must
     delete the old one first.
2. Use: a text node calls the tool "request with a secret" with the name, an address, a method
   (GET, POST, PUT, PATCH or DELETE), and for methods other than GET an optional body (JSON, form,
   or plain text) and optional extra headers. The app adds the value and sends the request.
   - The approval rules of 007 apply. Methods other than GET are risky steps. A rule matches the
     name of the secret and a method, or "any method".
   - The card in the chat shows the name of the secret, the method and the address. It never
     shows the value.
3. Forget: a text node calls the tool "forget a secret" with a name. The value leaves the
   keychain. A request that has already started can end.
4. Vault: the Secrets tab of the workflow view holds the vault of the open workflow. It has two
   lists: "Saved secrets" and "Saved logins". Each row shows the name, the origin, the way to send
   it (or the user name for a login), the date it was saved, and the date it was last used. No row
   shows a value. The vault is the only place where the user manages secrets and logins.
   - Add: the user adds a secret or a login by hand.
     - The form for a secret asks for the name, the origin, the way to send it, and the hidden
       value. The form for a login asks for the name, the origin, the user name, and the hidden
       password.
     - The rules of the name hold. A name that the vault already holds is refused, ignoring case.
       The origin rules hold: https, and an address on this computer or the local network only
       when the switch is on. The limits hold: at most 100 secrets and 50 logins for a workflow,
       and a value of at most 16384 characters.
     - When a limit is reached, the form is refused with the reason: "This workflow holds 100
       secrets.", "This workflow holds 50 logins.", or "The value is too long." Cancel closes the
       form and saves nothing.
   - Rename: the user renames a secret or a login. The rules of the name hold. A name that the
     vault already holds is refused, ignoring case. The permission rules of 007 that name the old
     name move to the new name: a Deny rule still stops the renamed row, and the old name keeps
     no rule. A node that calls "request with a secret" or "sign in with a login" with the old
     name fails as unknown. A node that calls "ask for a secret" or "ask for a login" with the old
     name gets a new protected card, because no row holds that name.
   - Replace: the user types a new value in a hidden field. The field is cleared when the save
     starts. The next request or fill uses the new value.
   - Test: each secret has a Test button. It sends a GET request to the origin with the secret and
     shows the status code on the row, or the reason when the request fails (for example refused
     or timeout). Test follows the address rules of a request with a secret: https, the switch for
     this computer and the local network, no redirect, the refusal of link-local and cloud
     metadata addresses, and the time limit of 30 seconds. It never shows the value. Test does
     not change the date last used. The result stays on the row until the next Test. Logins have
     no Test button: the fill at run time is the test.
   - Delete: the user deletes a secret or a login after a confirm (000). The value leaves the
     keychain at once. A request that has already started can end.
   - Settings → Permissions holds an overview, "Saved secrets". It lists each workflow that holds
     a secret or a login: the name of the workflow, the count of secrets, the count of logins, and
     a link "Open vault" that opens the vault of that workflow. It shows no value, and the user
     cannot add, replace or delete there.
5. Ask the responsible document: while a protected card waits, the user can ask in the chat how
   far the run has gone or why it waits (003). The answer says that the run waits for the answer to
   the card of a secret at that node, and that the card is in the chat. The answer never holds a
   value.

## Saved logins

A saved login lets a text node sign in to a site in its browser (007) while the model never sees
the user name or the password.

- **Saved login**: a name, the workflow, the origin of the site (scheme, host and port), a user
  name and a password. Both values are in the system keychain (014), never in the database. The
  name follows the rule of a saved secret: 1 to 40 characters, unique for its workflow, ignoring
  case. A workflow can have more than one login for one site, under different names, for example
  for two accounts.
- Ask: a text node calls the tool "ask for a login" with a name, a short label, the reason and the
  origin. The chat shows a protected card with the reason, the origin in large text, a field for
  the user name, a hidden field for the password, Save and Cancel.
  - Save puts both values in the keychain. The fields are cleared when the save starts. The card
    then shows "Saved". The node gets the name, never a value.
  - Cancel: the card shows "Cancelled", and the node gets that answer.
  - When a login with the same name and the same origin exists, no card shows, and the node gets
    the name. A login with the same name and another origin is refused.
- Use: a text node calls the tool "sign in with a login" with a name, while its browser shows a
  page of that origin. The app finds the sign-in form: a password field and the field for the user
  name before it. It writes both values into the fields itself. The node presses the sign-in
  button with its normal browser tools. The values do not pass through the model.
  - The answer to the node is "Filled", with the names of the fields, or the reason in words:
    no form found, more than one form (the answer lists them by number), the page is not of this
    origin, or the field is in a frame of another site.
  - The app fills a form only when the page has exactly the origin of the login. It refuses a form
    whose action sends the values to another origin. It fills a frame only when the frame has the
    same origin.
  - The page text that the node reads shows the filled fields as hidden. The app replaces the
    values with `[redacted]` in any text that goes back to the node: texts of the screen, errors
    of the page and addresses.
- The approval rules of 007 apply. Filling a login is a browser step. The approval card shows the
  name and the origin, and says that the login will be filled. A rule can match the name of the
  login. A Deny rule wins.
- Manage: the "Saved logins" list of the vault of the workflow holds its logins. A row shows the
  name, the origin, the user name, the date it was saved and the date it was last used. It never
  shows a password. The user can add, rename, replace the values and delete a login after a
  confirm, as with secrets (see "Flows", item 4). The Settings overview counts the logins of each
  workflow and links to its vault.
- A workflow file (010) holds no login, so a workflow that an import makes has none. A duplicated
  workflow starts with an empty vault. Deleting a workflow deletes its vault: its logins leave the
  keychain at once. Renaming a workflow moves its vault with it. A workflow holds at most 50
  logins.
- An export holds the name, the workflow and the origin of each login, not the values. After an
  import each login shows "Value missing" in its vault. Logins do not sync (019).
- On a linked device (012), the protected card shows "Answer this on NAME". A value never goes
  over a device link.
- A node never types a card number, an address for payment, or a one-time code. These are not
  saved logins and are not in this version.

## States

- Empty vault: with no saved secret, the "Saved secrets" list shows one muted line that says what
  a saved secret is. With no saved login, the "Saved logins" list shows one muted line that says
  what a saved login is.
- Loading: while the vault reads the keychain, it shows "Loading…".
- Keychain error: when the keychain cannot be read, the vault shows "Cannot read the vault." with
  Retry. A request with a secret then fails with that reason until the keychain can be read again.
- A secret whose value is missing (for example after an import, see 014) shows "Value missing".
  A request with it fails with that reason until the user replaces the value.
- A protected card that waits counts as a question for the island and the notifications (see
  015). The island has no field: a click opens the chat of the workflow. The task waits for the
  user, with no time limit, also in a run that a trigger started (005).
- On a linked device (012), the protected card shows "Answer this on NAME", with the name of the
  computer that runs the workflow. A value never goes over a device link.

## Rules

- The model has no tool that reads a value. The app never puts a value into a shell command, a
  file, an environment value, a browser page, a message, a log, the action log, or an export. The
  responsible document and the run view show no value.
- The address of a request must have the same scheme, host and port as the origin of the secret.
  Else the request is refused with the reason.
- The app does not follow a redirect. A redirect ends the request with its status and the new
  address, and the node can make a new request.
- The app refuses an address that leads to a link-local address or to a cloud metadata address.
- An address on this computer (`127.0.0.1`, `localhost`, `::1`) or on the local network may use
  http, and is allowed at all, only when the switch "Allow saved secrets on this computer and the
  local network" is on. It is in settings, Permissions, and it is off by default. The switch says
  that such a request travels without encryption on the network.
- A request has a time limit of 30 seconds. The app reads at most 1 MB of the answer. The node
  gets the status, the content type, and at most 20000 characters of the body. It gets no
  headers of the answer. When the body was cut, the node is told so.
- Before the node gets the answer, the app replaces the value with `[redacted]` in it, also in
  its common encodings (base64, URL encoding and hex). The service still receives the value. The
  user must pick services that they trust.
- The answer is outside content (see 007). In a task that holds outside content, a request for a
  new secret and a request with a method other than GET are guarded steps (007, "Outside
  content"): they ask with an approval card, also when a rule matches.
- At the level "Read only", a request for a new secret and a request with a method other than GET
  are refused (007, "Permission levels").
- A workflow holds at most 100 saved secrets. A value holds at most 16384 characters.
- A text node reads only the secrets and logins of its own workflow. A name from another
  workflow is refused as unknown.
- A workflow file (010) holds no secret, so a workflow that an import makes has none. A
  duplicated workflow starts with an empty vault. Renaming a workflow moves its vault with it:
  the rows stay, under the new name. Deleting a workflow deletes its vault: its secrets leave the
  keychain at once.
- An export holds the name, the workflow, the origin and the way to send each secret, not the
  value. After an import, each secret shows "Value missing" in its vault.
- Saved secrets do not sync (019). The values are in the keychain of one computer. The vault of
  the other computer does not show them. Each computer shows the vaults of its own workflows only.
- These tools are for text nodes whose model comes from an API provider (see 006), as connections
  are (see 018).

## Surfaces

- **Ways in**: the tools of a text node (007), the Secrets tab of the workflow view for the user,
  and Settings → Permissions → "Saved secrets" as an overview with a link to each vault. The user
  adds a secret or a login in the vault only.
- **Devices**: the computer shows and manages the vault. A linked device (012) and the phone (011)
  show the vault as one muted line, and never take or send a value. They can show the protected
  card as "Answer this on NAME".
- **Runtimes**: a text node on a provider that is not an API provider (006) has no tool of this
  spec. A decision node has none (010).
- **Ways out**: add, rename, replace, test and delete in the vault, "forget a secret" for a node,
  and Cancel on a card. A delete asks first (000).
- **Seeing the state**: the card in the chat, the run view (the task waits for the user), the vault
  of the workflow, the overview in Settings, and "Value missing". All stay after a restart, except
  a card of a task that the restart ended (010).
- **Data**: the keychain holds the values. The database holds the other fields. See "Rules".
- **Words**: "Vault" goes in `docs/glossary.md`, in English and Korean.

## Out of scope

- A sign-in through a browser window for a request with a saved secret (the browser tool has
  saved logins, see above), and tokens that the app must refresh.
- Requests that must be signed, or that need more than one secret.
- A secret in a shell command or in an environment value.
- A secret that the responsible document uses, or that two workflows share.

## Acceptance

All checks use a small test web service, written for the test.

- A text node asks for the secret `test_api` for `https://127.0.0.1:PORT` with a bearer token, and
  the switch for this computer is on. The card shows the origin and shows in the chat of the
  workflow. Save a value: the database file, the logs, the chat and an export hold no clear text of
  it.
- A GET request with the secret: the test service gets the header with the value. The node gets
  the body.
- The test service sends the value back in its body, as plain text and as base64: the node gets
  `[redacted]` in both places.
- A request with the secret to another port: the app refuses it.
- The test service answers with a redirect: the app does not follow it, and the node gets the
  status and the new address.
- With the switch for this computer off, a request to `127.0.0.1` is refused with the reason.
- A POST at "Ask for risky steps" shows an approval card with the name, the method and the
  address. "Always allow for this workflow" saves a rule. The next POST runs with no question.
- A POST in a task that holds outside content, at "Full access" with an Allow rule: an approval
  card shows. At "Read only": the POST is refused.
- Ask for the same secret again: no card shows. Ask with "replace": a card shows.
- A protected card waits in a run. Ask the chat "Why does it wait?": the answer names the node and
  says that the run waits for the card of a secret. The answer holds no value. A run that a
  schedule started waits with no time limit.
- Delete the secret in the vault: the next request fails, and the keychain no longer holds it.
- Export, then import into an empty app: the vault of the workflow shows the secret with "Value
  missing".
- Import a workflow file: the new workflow has an empty vault. Duplicate a workflow with a secret:
  the copy has an empty vault.
- A test service that waits 40 seconds: the request fails after 30 seconds.
- A test page has a sign-in form at `https://127.0.0.1:PORT`. A text node asks for the login
  `test_user`. The card shows the origin. Save a user name and a password: the database file, the
  logs, the chat and an export hold no clear text of them. The node calls "sign in with a login":
  the page fields hold the values, the answer says "Filled", and the model request holds neither
  value. The test page echoes the user name in an error text: the node gets `[redacted]`.
- A page of another port: the call is refused with the reason. A form that sends to another origin
  is refused. A page with two forms: the answer lists them by number.
- At "Ask for risky steps", filling shows an approval card with the name and the origin.
  "Always allow for this workflow" saves a rule, and the next fill runs with no question. A Deny
  rule stops it at every level.
- Export and import into an empty app: the vault shows the login with "Value missing", and the
  call fails with that reason until the user replaces the values.
- Save a login, then delete the workflow: the keychain holds no value of it. Ask for a login with
  the same name and another origin: the app refuses it. Press Cancel on the card: the node gets
  "Cancelled". Ask for 51 logins for one workflow: the 51st is refused.
- Open the vault of a workflow that holds a secret, while another workflow holds a secret of the
  same name: the vault shows only the secrets of the open workflow. A request that names the other
  workflow's secret is refused as unknown.
- Add a secret `hand_api` by hand in the vault: the next request with that name runs with no card.
  Rename it to the name of a secret that the vault holds: the app refuses it. Replace its value:
  the next request uses the new value. Press Test: the vault shows the status code, and the logs
  hold no clear text of the value. With the switch for this computer off, press Test on a secret
  for `https://127.0.0.1:PORT`: the vault shows the reason, and the test service gets no request.
- Rename a secret with a Deny rule for its name: the next POST is still refused, and asking with
  the old name shows a new card.
- Rename a workflow that holds a secret: the vault shows the same rows under the new name.
  Settings → Permissions shows the counts of each workflow with "Open vault", and no value.
- A decision node and the responsible document have no tool of this spec.
