# 025 Voice

## Purpose

The user speaks to an agent and hears the answer, on the computer and on the phone, with no typing.

## Concepts

- **Dictate**: speech that the app turns into text in the message box. The app does not send it.
- **Read aloud**: the app speaks a finished message of an agent.
- **Voice chat**: on the phone, a spoken talk with one agent. The user speaks and the app reads the
  reply.
- **Recogniser**: the speech recognition of the system of the device. It must run on the device.

## Flows

1. Dictate: the message box has a microphone button, on the computer and on the phone (and in the
   box of a thread and of a channel). The user holds the button, or presses it once to start and
   once to stop.
   - The text shows in the box at the place of the cursor while the user speaks. The part that is
     not final shows muted and can change.
   - The app sends nothing. The user can edit the text and then sends it as any message.
   - On the computer the key Cmd+Shift+D starts and stops dictation. The help page lists it (001).
   - Dictation stops when the user presses the button, when the box loses the focus, when the user
     sends the message, and after 10 seconds of silence. After 10 seconds of silence a muted line
     says that nothing was heard.
2. Read aloud: the actions of a finished message of an agent have "Read aloud" (the hover actions
   on the computer, the long press on the phone). While it reads, the action reads "Stop reading".
   - One message is read at a time. A new "Read aloud" stops the one that reads.
   - Leaving the chat, a new turn that the user starts by voice, and a call or an alarm of the
     system stop the reading.
3. Voice chat (phone only): the header of a direct chat has a button "Voice chat". It opens a full
   screen with the face of the agent, one word for the state (Listening, Thinking, Speaking,
   Waiting for you) and the buttons "Mute" and "End".
   1. Listening: the user speaks. When the user stops and 1.5 seconds pass in silence, the
      recognised text is sent as a message of the user, as if typed.
   2. Thinking: the agent works as for a typed message. The user sees its steps as in the chat.
   3. Speaking: the app reads the reply sentence by sentence, from the first full sentence on,
      while the rest still arrives. It follows "Rules" for what it reads.
   4. When the user speaks while the app reads, the reading stops at once and listening starts.
   5. A question card is read aloud, and the user can answer it by voice: the text becomes the
      answer, as in 003. An approval card is not read. The state is "Waiting for you" and the user
      answers by touch. Then listening goes on.
   6. End closes the screen. Reading stops. Nothing else changes.
   - The screen stays awake while voice chat runs. When the app leaves the screen, voice chat ends.
   - "Mute" turns the microphone off. The state reads "Muted", the agent goes on, and its reply
     is still read. A second press turns listening on again.
   - Voice chat is for a direct chat. It is not in a channel in this version.
4. Settings: Settings → General (013) has "Dictation language" (the language of the interface by
   default, or a language that the recogniser of the device offers) and "Reading speed" (slow,
   normal, fast). The phone has the same two settings in its Settings.

## Rules

- Recognition runs on the device. No sound leaves the device, the app stores no sound, and an
  export holds none (014). The recognised text is a message like any typed message once it is
  sent.
- If the device has no recogniser of its own for the language, the microphone button is off and
  says why in words, with where to add the language in the settings of the system. The app never
  falls back to a recogniser that sends the sound to a service.
- The first press asks the system for the microphone, and for speech recognition where the system
  asks for it. A line that tells why comes first. If the user says no, the button shows a line
  that tells where to turn it on.
- Read aloud reads the plain text of the message, in order. It skips code blocks, tool cards,
  thinking, images and the cells of tables, and it says the text of a link, not the address. The
  app takes the language of the message from its text: Korean when most letters are Hangul,
  English in the other case. It uses the voice of the system for that language. If the device has
  no voice for it, "Read aloud" is off and says why.
- Only one of dictate, read aloud and voice chat is active on a device. Starting one stops the
  other. Dictation never starts while the app reads.
- A message that holds outside content (007) is read like any other message. Reading changes no
  mark.
- On a client of a linked server (012), recognition and reading run on the device of the client.
  The server gets text only. A linked computer has dictate and read aloud. It has no voice chat.
- Another profile (022) has the same settings of its own.

## States

- Listening: the button shows an active state with text for screen readers, and a small level bar.
  Colour alone is not enough.
- No speech heard, no permission, no recogniser, no voice: a muted line in plain words. No error
  row, no notification.
- Offline link to a linked server: dictation and reading still work. Sending waits as for typed
  text (012).

## Surfaces

- Ways in: the microphone button, the shortcut on the computer, "Read aloud" in the message
  actions, "Voice chat" in the header on the phone.
- Devices: computer (dictate, read aloud), linked computer (the same), phone (all three), a
  second profile (the same as the first).
- Runtimes: nothing changes. The agent gets text only. An agent on a vendor runtime works as for a
  typed message.
- Ways out: the same button, "Stop reading", "End".
- Seeing the state: the active microphone, the word for the state in voice chat, "Stop reading".
  Nothing is stored, so nothing stays after a restart.
- Data: no sound is stored or synced. The two settings belong to the device.
- Words: see `docs/glossary.md`.

## Out of scope

- A wake word, and voice that runs while the app is closed.
- Voice chat on the computer, and voice chat in a channel.
- Choice of a synthetic voice, and a voice that the app brings itself.
- Sound files as attachments. They follow the attach rules of 003.

## Acceptance

All checks use a stand-in recogniser and a stand-in speaker.

- Hold the microphone button, the stand-in recogniser hears "write a short note": the text shows in
  the box, muted first and normal when final. Nothing is sent. Press Enter: the message is sent.
- Dictate with the cursor in the middle of a text: the new text sits at the cursor.
- The stand-in recogniser hears nothing for 10 seconds: dictation stops and a muted line says so.
- A device with no recogniser for Korean: the button is off, with the reason, when the dictation
  language is Korean. The stand-in records no call to any service.
- Deny the microphone: the button shows the line with where to turn it on.
- "Read aloud" on a reply with a code block, a link and an image: the stand-in speaker gets the
  text without the code and without the image, and the link text only.
- Start "Read aloud" on a second message: the first stops. Leave the chat: the reading stops.
- Voice chat on the phone: the stand-in recogniser sends a sentence, then 1.5 seconds of silence:
  one message is sent. The reply streams: the stand-in speaker gets the first sentence before the
  reply has ended.
- The user speaks while the stand-in speaker reads: the speaker stops and listening starts.
- A question card comes: the stand-in speaker gets its text. The user speaks an answer: the card
  shows "Answered in the chat". An approval card comes: the speaker is silent, the state reads
  "Waiting for you", and Allow by touch lets the turn go on.
- Send the app to the background in voice chat: voice chat ends.
- A database file, a log and an export hold no sound.
- Press Cmd+Shift+D on the computer: dictation starts. Press it again: it stops. Press the button
  once, then once again: the same. Dictation stops when the box loses the focus, and when the user
  sends the message.
- Set the reading speed to "fast": the stand-in speaker gets the fast rate. Set the dictation
  language to Korean: the stand-in recogniser gets Korean.
- A stand-in call or alarm takes the audio: reading and voice chat end.
- Press "Mute" in voice chat while a reply streams: the state reads "Muted", the reply is still
  read, and the stand-in recogniser gets no sound. Press it again: listening goes on.
- The stand-in speaker has no voice for the language of a message: "Read aloud" is off with the
  reason.
- Dictate in a chat of a linked server whose link is offline: the text shows in the box, and
  sending waits.
