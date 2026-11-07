# 039 Looping motion

## Purpose

A mark that shows "work is running" moves in the same way in every place of the app, and it stops
when the user asks for less motion.

## Concepts

- **Spinner**: a turning mark for a node, a step or a task that is running. Examples: the turning
  mark of a running node on the canvas (000, "turn") and at the head of the chat of a workflow.
- **Pulse**: a mark that grows and fades again and again to show that a task works (000,
  "breath"). Examples: the working mark of a task and the glow of the brand mark.

## Rules

- All spinners turn at the same speed. All pulses beat at the same speed. A pulse is slower than
  a spinner.
- A spinner or a pulse never ends while its work runs, and it ends when the work ends.
- With "reduce motion" on (013), or with "reduce motion" on "follow the system" and the system
  asking for less motion, no spinner turns and no pulse beats. The mark stays still and visible,
  so the user can still see that work runs (000, 001, 015).
- A change of the setting works at once, with no restart.

## Surfaces

The server rail and the workflow list, the workflow view with its canvas and its chat, and the
brand mark. The status island keeps its own rules (015).

## Out of scope

Motion that ends by itself (a card that enters, a section that opens). Rules for the status
island window.

## Acceptance

- Two spinners on one screen, for example on the canvas and in the chat, turn in step with the same
  period.
- Turn on "reduce motion": every spinner and every pulse is still, and each is still visible.
- Turn it off: they move again with no restart.
