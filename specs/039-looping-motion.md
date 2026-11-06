# 039 Looping motion

## Purpose

A mark that shows "work is running" moves in the same way in every place of the app, and it stops
when the user asks for less motion.

## Concepts

- **Spinner**: a turning mark for a step or a task that is running. Examples: the turning mark in
  the sidebar and at the head of a chat.
- **Pulse**: a mark that grows and fades again and again to show that an agent works. Examples:
  the working dot of the sidebar and the glow of the brand mark.

## Rules

- All spinners turn at the same speed. All pulses beat at the same speed. A pulse is slower than
  a spinner.
- A spinner or a pulse never ends while its work runs, and it ends when the work ends.
- With "reduce motion" on (013), or with "reduce motion" on "follow the system" and the system
  asking for less motion, no spinner turns and no pulse beats. The mark stays still and visible,
  so the user can still see that work runs (000, 001, 015).
- A change of the setting works at once, with no restart.

## Surfaces

The sidebar and its header, the chat view and the brand mark. The status island
keeps its own rules (015).

## Out of scope

Motion that ends by itself (a card that enters, a section that opens). Rules for the status
island window.

## Acceptance

- Two spinners on one screen, for example in a chat and in the sidebar, turn in step with the same
  period.
- Turn on "reduce motion": every spinner and every pulse is still, and each is still visible.
- Turn it off: they move again with no restart.
