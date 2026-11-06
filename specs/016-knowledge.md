# 016 Knowledge

## Purpose

An agent builds a small set of linked articles about what it reads and does, and reads them again
in later chats. The user can read, edit and check every article. Memory (008) keeps short facts.
Knowledge keeps longer, structured notes that cite where they come from.

## Concepts

- **Knowledge**: all the articles of one agent. Each agent has its own. Agents do not read each
  other's knowledge.
- **Article**: a title (1 to 80 characters), a summary line (up to 160 characters), a body in
  Markdown (up to 20,000 characters), links to other articles by title, the sources it uses, and
  the time of the last change. The title is unique for the agent. The rule ignores case. An
  article is one Markdown file, named after its title. In the body, a link is the title between
  double square brackets. A Markdown file with no title and no summary is an article too: its
  title is the file name and its summary is its first line.
- **Source**: a file or a web page that an article uses. The app keeps a copy of the source as it
  was when the agent read it. A source never changes. A page is saved as text, and the first line
  holds the page address. The app does not save the same content twice. Sources are in a folder
  named "sources" inside the Knowledge folder.
- **Contents list**: one line for each article: title and summary. The app keeps it current.
- **Change**: one add, edit or delete of an article. The app keeps the last 50 changes of an agent,
  each with the earlier text, who made it (the agent or the user) and when.

## Flows

1. Write from the chat: the agent finds a lasting topic that is too long or too linked for a
   memory item. It writes a new article, or it updates an article that exists. The agent cannot
   rename an article. The chat shows a muted line, "Updated article: <title>", with an undo
   control. A turn makes at most 5 changes. Each saved add, edit or delete is one change. A
   source, a read and a failed change do not count.
2. Add a source: the user attaches a file, or asks the agent to read a page, and says to add it to
   knowledge. The app keeps the source. The agent writes or updates articles that cite it. The
   chat shows one muted line for each change.
3. Use knowledge: before each turn, the agent gets the contents list. The agent opens the articles
   it needs. Each opened article shows as a compact card in the reply: "Read article: <title>".
4. Browse: "Knowledge" is a second page in the agent profile. A list of articles with search is on
   one side. The chosen article is on the other side, with its links, its sources and the time of
   the last change. A link opens the linked article. A link to an article that does not exist is
   marked.
5. Edit: the user can add, edit or delete an article, and open the sources. A source can be
   deleted, but not edited. The delete of a source is a danger button that asks first (000,
   "Danger buttons"). The user can edit articles also when knowledge is off.
6. Undo: the user undoes a change from the chat line or from the change list. The article returns
   to its earlier text. A deleted article returns. Undo does not look at later changes of the same
   article: it puts the earlier text back. An undo is a new change by the user, so the user can
   undo it again.
7. Check: the user presses "Check knowledge". The app finds links to missing articles, articles
   that no other article links to, and articles with no source. A source that the user deleted
   does not count as a source. With one article, the app does not report articles that no other
   article links to. The chat shows these findings as a message from the user, with a request to
   read all articles and to add statements that disagree. The agent answers with the report. It
   changes nothing until the user says so.
8. Make a skill: the view of an article has "Make a skill". It opens a card on the page
   "Self-improvement" of the agent. The model of the agent writes a draft from the article, and the
   draft is a proposal of a new skill (see 017, "Make a skill from work", and 002,
   "Self-improvement"). Nothing is saved before the user accepts. It is on the computer only.

## States

- Empty: "No articles yet." One muted line says that the agent adds articles as it works, and
  that the user can add one.
- The page shows, under its title, the same muted line as the memory page (see 008): an agent gets
  better through its Soul, memory, knowledge and skills, and through the proposals that the user
  accepts, and ROBot does not train the model. The line shows also when knowledge is off.
- Working: while the agent writes, the chat shows the reply as usual. The change line appears when
  the change is saved.
- Failed: a change that cannot be saved shows its error in the card. The turn continues.
- Off: the list stays visible, with the muted line "Knowledge is off for this agent." The switch
  for one agent acts at once.
- Over the limit: with 500 articles, the agent cannot add more, and the button for a new article
  is off. The agent tells the user in the reply.
- No folder yet: the "Open folder" control is off until the first article is saved.

## Rules

- Articles and sources are plain files in a folder named "Knowledge" in the agent workspace
  (007). The user can open the folder from the Knowledge page and use other apps to read the
  files. This is the one place where files, not the database, are the source of truth (014). The
  app reads the folder again when it changes, also when the user changed it outside the app.
- The app creates the folder when the first article is saved.
- A workspace counts as chosen by the user when it is not in the default workspace folder. A
  folder under a root that the user set in Settings is in the default workspace folder.
- In a chosen workspace, the first save by the agent into a missing Knowledge folder asks for
  approval, for an article or for a source. The card names the folder. A save by the user does
  not ask. At the permission level "Full access", nothing asks.
- Knowledge is local. Nothing is sent anywhere except to the model provider that the agent uses.
- The agent cannot edit or delete a source. The agent cannot write outside the Knowledge folder
  with the knowledge tools. The general file tools of the agent do not work on a source, and do
  not work in the Knowledge folder while knowledge is on. The agent gets a plain error and uses
  the article tools.
- An article the user edited last is protected: before the agent changes or deletes it, an
  approval card shows the new text beside the old text. Allow once and Deny are the choices. At
  the permission level "Full access", the card does not show. A change that the user made
  outside the app, and an undo, count as an edit by the user.
- The app refuses to save a text that equals a stored key or looks like a key or a token. This
  holds for an article and for a source that the agent adds. The card shows a plain error. The
  app does not check a file that the user puts in the folder.
- A file in the Knowledge folder that another app wrote does not need to meet the limits for
  title, summary and body. The limits hold when the app or the agent saves. A second file whose
  title is already taken is not shown, and the page says how many files it hides. Hidden files
  and folders other than "sources" are ignored.
- Memory and knowledge are separate. The user can turn knowledge off for one agent. Existing
  articles stay, but the agent does not read them and has no knowledge tools.
- The contents list in a turn is at most 100 lines and 6,000 characters. If the whole list fits,
  the agent gets all of it. If it does not fit, the app gives the lines that share words with the
  new message first, then the newest. After a list that is cut, one line says how many articles
  are not in it.
- An agent runtime from a vendor (006) gets the contents list and a short description of the
  folder in its instructions. It reads and writes the folder with its own file tools and its own
  permission prompts. The app reads the folder again after the turn and counts the changes as the
  changes of the agent. If a changed file holds a stored key or a token, the app puts back the
  earlier text, or deletes the file if it is new. The limits of 5 changes in a turn and of 500
  articles are only told to the runtime in its instructions.
- Archiving an agent keeps its knowledge. Deleting an agent deletes it with the workspace.
- Knowledge is part of the export (014). Sources are copied as they are. An import restores it.
- An agent file (002) holds no knowledge, as it holds no memory.

## Out of scope

- Knowledge that several agents share.
- Search by meaning (embeddings). Search uses words.
- A graph view of the links.
- Research that runs many agents in parallel.
- Import from other wiki or note apps.
- Publishing articles outside the computer.

## Acceptance

- Attach a file and ask the agent to add it to knowledge: an article appears with the file as its
  source, the chat shows a change line with undo, and the source file is unchanged.
- In a later turn, ask a question that the article answers: the reply shows a "Read article" card
  and uses the article. The reply comes from the contents list and the opened article, not from
  earlier messages.
- Edit an article as the user, then ask the agent to change it: an approval card shows. Deny keeps
  the text.
- Change an article file in another app, then ask the agent to change it: an approval card shows.
- Delete an article: a later turn cannot use it. Undo the delete: it can. Undo the undo: it is
  deleted again.
- Turn knowledge off: a later turn does not read the articles.
- Delete an article that another article links to: "Check knowledge" reports the broken link.
- Ask the agent to save a stored key in an article: the change fails and the file does not hold
  the key.
- Ask the agent to add a file that holds a stored key as a source: the change fails and no source
  is saved. After an export, the archive holds no stored key.
- Ask for 6 article changes in one turn: 5 are saved, and the sixth fails with a plain error in
  its card.
