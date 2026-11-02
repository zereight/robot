# 012 Desktop-to-phone link

## Purpose

The phone reaches the user's computer securely from anywhere, without conversation content going
through or being stored on a third-party server.

## Pairing

1. On the computer, settings → Devices → "Pair a phone" shows a QR code and a 6-digit code that
   expire in 5 minutes.
2. The phone scans the QR code (or types the computer's address and code).
3. The computer shows "Allow <phone name>?" with Allow and Deny.
4. On Allow, both sides store each other's public key. Later connections need no code.

## Connection

- The two sides connect directly when they can (same network, or a direct path through the
  internet). When they cannot, traffic goes through a relay that sees only encrypted data.
- A small connection service may help the two sides find each other. It sees device ids and
  network addresses, never messages, files or commands.
- All traffic is end-to-end encrypted with the paired keys.

## Messages

- The phone asks for: server summary, places, a page of messages, send message, stop, approve,
  answer question, upload attachment, download attachment, retry a task, end a request (see 004),
  mark a place read, start and fork a thread, compact a conversation, and run or edit a workflow.
  Whatever the user can do in a conversation on the computer, the phone can ask for.
- The computer pushes: new and changed messages, task state changes, agent state changes,
  approval requests.
- Each message has a type, an id, and a version number. Both sides use one protocol version; a
  peer with another version gets a clear "Update the app" error.

## Rules

- The computer can list paired phones and revoke one; a revoked phone cannot connect and must
  pair again.
- Lost connection: the phone retries with backoff up to 30 seconds between tries and shows
  "Reconnecting".

## Acceptance

- Pair on the same Wi-Fi, then switch the phone to mobile data: it reconnects and works.
- Revoke the phone: its next request fails and it shows the pairing screen.
