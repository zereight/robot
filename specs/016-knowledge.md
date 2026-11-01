# 016 Knowledge

## Purpose

An agent builds a small set of linked articles about what it learns, and reads them again in later
chats. The user can read, edit and check every article. Memory (008) keeps short facts. Knowledge
keeps longer, structured notes that cite where they come from.

## Concepts

- **Knowledge**: all the articles of one agent. Each agent has its own. Agents do not read each
  other's knowledge.
- **Article**: a title (1 to 80 characters), a summary line (up to 160 characters), a body in
  Markdown (up to 20,000 characters), links to other articles by title, the sources it uses, and
  the time of the last change. The title is unique for the agent. The rule ignores case.
- **Source**: a file or a web page that an article uses. The app keeps a copy of the source as it
  was when the agent read it. A source never changes.
- **Contents list**: one line for each article: title and summary. The app keeps it current.
- **Change**: one add, edit or delete of an article. The app keeps the last 50 changes of an agent,
  each with the earlier text, who made it (the agent or the user) and when.

## Flows

1. Learn from the chat: the agent finds a lasting topic that is too long or too linked for a
   memory item. It writes a new article, or it updates an article that exists. The chat shows a
   muted line, "Updated article: <title>", with an undo control. A turn makes at most 5 changes.
2. Add a source: the user attaches a file, or asks the agent to read a page, and says to add it to
   knowledge. The app keeps the source. The agent writes or updates articles that cite it. The
   chat shows one muted line for each change.
3. Use knowledge: before each turn, the agent gets the contents list. The agent opens the articles
   it needs. Each opened article shows as a compact card in the reply: "Read article: <title>".
4. Browse: the user opens "Knowledge" in the agent profile. A list of articles with search is on
   one side. The chosen article is on the other side, with its links, its sources and the time of
   the last change. A link opens the linked article. A link to an article that does not exist is
   marked.
5. Edit: the user can add, edit or delete an article, and open the sources. A source can be
   deleted, but not edited.
6. Undo: the user undoes a change from the chat line or from the change list. The article returns
   to its earlier text. A deleted article returns.
7. Check: the user presses "Check knowledge". The agent reads the articles and posts a report in
   the chat: links to missing articles, articles that no other article links to, articles with no
   source, and statements that disagree. The agent changes nothing until the user says so.

## States

- Empty: "No articles yet." One muted line says that the agent adds articles as it learns, and
  that the user can add one.
- Working: while the agent writes, the chat shows the reply as usual. The change line appears when
  the change is saved.
- Failed: a change that cannot be saved shows its error in the card. The turn continues.
- Off: the list stays visible, with the muted line "Knowledge is off for this agent."
- Over the limit: with 500 articles, the agent cannot add more. It tells the user in the reply.

## Rules

- Articles and sources are plain files in a folder named "Knowledge" in the agent workspace
  (007). The user can open the folder from the Knowledge page and use other apps to read the
  files. This is the one place where files, not the database, are the source of truth (014). The
  app reads the folder again when it changes, also when the user changed it outside the app.
- The app creates the folder when the first article is saved. If the user chose the workspace (it
  is not the default), the first save asks for approval, and the card names the folder.
- Knowledge is local. Nothing is sent anywhere except to the model provider that the agent uses.
- The agent cannot edit or delete a source. The agent cannot write outside the Knowledge folder
  with the knowledge tools.
- An article the user edited last is protected: before the agent changes it, an approval card
  shows the new text beside the old text. Allow once and Deny are the choices. At the permission
  level "Full access", the card does not show.
- The app refuses to save a text that equals a stored key or looks like a key or a token. The card
  shows a plain error.
- Memory and knowledge are separate. The user can turn knowledge off for one agent. Existing
  articles stay, but the agent does not read them and has no knowledge tools.
- The contents list in a turn is at most 100 lines and 6,000 characters. If the list is longer,
  the app gives the lines that share words with the new message first, then the newest.
- An agent runtime from a vendor (006) gets the contents list in its instructions. It reads and
  writes the folder with its own file tools and its own permission prompts. The app rebuilds the
  contents list after the turn.
- Archiving an agent keeps its knowledge. Deleting an agent deletes it with the workspace.
- Knowledge is part of the export (014). Sources are copied as they are.
- In a channel (004), an agent uses only its own knowledge.

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
- Open a new chat and ask a question that the article answers: the reply shows a "Read article"
  card and uses the article.
- Edit an article as the user, then ask the agent to change it: an approval card shows. Deny keeps
  the text.
- Delete an article: a new chat cannot use it. Undo the delete: it can.
- Turn knowledge off: a new chat does not read the articles.
- Delete an article that another article links to: "Check knowledge" reports the broken link.
- Ask the agent to save a stored key in an article: the change fails and the file does not hold
  the key.
