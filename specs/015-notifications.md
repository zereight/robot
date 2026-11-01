# 015 Notifications and the status island

## Purpose

The user knows when an agent needs them or finishes, without watching the window.

## System notifications

- Kinds: reply in a direct chat while the window is not focused, mention in a channel, approval
  request, question, task failed, routine failed.
- Each kind can be turned off. A server or a channel can be muted for 1 hour, 8 hours, 1 day, or
  until turned back on.
- Clicking a notification opens the place and scrolls to the message.

## Status island (macOS, optional)

- A small dark shape at the top centre of the screen, around the camera notch when there is one.
- Idle: the app mark at the left and a still muted dot at the right. Nothing moves when idle.
- Working: the faces of working agents (up to 3) and a count.
- Attention: an approval or question expands the island with the agent face, a one-line summary
  and buttons to answer or open the app.
- The user can turn it off, or show it only for attention.

## Rules

- Do-not-disturb of the system is respected.
- Motion in the island is short (under 300 ms) and follows reduce motion.

## Acceptance

- An approval request with the window hidden shows a notification and expands the island; Allow
  on the island lets the task continue.
