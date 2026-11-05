# Product

## Register

product

## Users

One person on one Mac, usually an Apple silicon laptop. They run a small team of AI agents
the way they would run a group chat: a direct chat with one agent, a channel with several.

The context is a working day, not a browsing session. The window stays open beside an editor,
a terminal and a browser. The user looks at it many times an hour, for a few seconds each time,
to answer one question: what needs me, and what is running.

The job to be done is direction, not conversation. The user writes a short instruction, reads
a streamed reply, approves or denies a risky step, and moves on. The value of the app is that
the user trusts the state it shows without reading it twice.

## Product Purpose

ROBot runs AI agents on the user's own computer. Each agent is a member with a face, a name,
a role and a workspace. The user directs them; they do the work.

The product exists because a chat box alone does not show what is happening. The app shows the
plan, the parts, the members at work, the approvals that wait, and the record of what was done.

Success looks like this: the user opens the window, sees in one look what waits for them,
answers it, and closes the window. No hunting. No second look. No guessing whether the dot
means "working" or "finished".

## Brand Personality

Calm, exact, and quietly warm. It is a night desk: the lights are low, the surfaces are deep,
and the few things that matter glow.

The voice is a colleague who does not repeat themselves. Short sentences. Sentence case. A
number instead of an adjective. The app never congratulates the user and never sells itself.

Warmth comes from the mark and from the light, not from decoration: two smiling eyes in a night
sky, a glowing dot that says an agent is alive. That is the whole emotional vocabulary.

## Anti-references

- **The generic AI tool.** Violet-to-cyan gradients on a black page, glass cards, glowing
  borders, a robot mascot. ROBot already has a real mark; it does not need the category costume.
- **The SaaS dashboard.** Big hero numbers, card grids of equal size, an eyebrow label above
  every section. This app is a place where work happens, not a report about work.
- **The dense terminal.** Monospace everywhere, hairline grey lines, no hierarchy. The user
  directs agents in prose; the interface must read as prose.
- **The Slack clone.** The layout borrows from chat servers, but the look must not. A chat
  server is a place to talk; this is a place to watch work finish.
- **Decorative depth.** Shadow as ornament, blur that hides nothing, borders that only add
  noise. Depth here answers one question: which surface is in front.

## Design Principles

1. **State before style.** Every visual difference answers a question the user has. If a new
   border, glow or motion answers no question, it does not ship.

2. **Two lights, two meanings.** The accent violet shows where the user is and what they can
   press. The mint glow shows what is alive and working. These two never trade places, and
   nothing else glows.

3. **The surface carries the structure.** Panels are told apart by their surface step, not by
   a box drawn around them. If the user cannot see a panel without its border, the step is wrong.

4. **Readable at arm's length.** The user glances at this window from a normal distance, so
   body text is prose size, not label size. A label may be small; a sentence may not.

5. **Quiet by default, loud only when wrong.** Errors, blocked parts and approvals may raise
   their voice. Everything else stays at one level of calm.

## Accessibility & Inclusion

- WCAG 2.1 AA. Every text colour reaches 4.5:1 against every surface it can sit on, and a
  glyph that carries meaning reaches 3:1. This is checked by a test, not by eye.
- Both a dark and a light theme are first class. Neither is a "safe" default; both must hold
  the same contrast and the same hierarchy.
- Three text sizes, set by the user, scale the whole interface through one root size.
- Reduced motion stops every motion, including the breathing dot. Content is never gated on a
  transition, so a stopped motion never hides information.
- State is never carried by colour alone. A working agent has a moving dot and a word; a failed
  step has an icon and a word.
- Korean and English are equal citizens. A line breaks between words in Korean, and no label
  is assumed to be short.
