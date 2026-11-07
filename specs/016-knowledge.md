# 016 Knowledge

## Purpose

A workflow builds a small set of linked articles about what its nodes read and do, and its text
nodes read them again in later runs. The user can read, edit and check every article. Memory (008)
keeps short facts. Knowledge keeps longer, structured notes that cite where they come from.

## Concepts

- **Knowledge**: all the articles of one workflow. Each workflow has its own. Workflows do not read
  each other's knowledge.
- **Article**: a title (1 to 80 characters), a summary line (up to 160 characters), a body in
  Markdown (up to 20,000 characters), links to other articles by title, the sources it uses, and
  the time of the last change. The title is unique for the workflow. The rule ignores case. An
  article is one Markdown file, named after its title. In the body, a link is the title between
  double square brackets. A Markdown file with no title and no summary is an article too: its
  title is the file name and its summary is its first line.
- **Source**: a file or a web page that an article uses. The app keeps a copy of the source as it
  was when it was read. A source never changes. A page is saved as text, and the first line holds
  the page address. The app does not save the same content twice. Sources are in a folder named
  "sources" inside the Knowledge folder.
- **Contents list**: one line for each article: title and summary. The app keeps it current.
- **Change**: one add, edit or delete of an article. The app keeps the last 50 changes of a
  workflow, each with the earlier text, who made it (a node or the user) and when.

## Flows

1. Write from a node: a text node finds a lasting topic that is too long or too linked for a
   memory item. It writes a new article, or it updates an article that exists. A node cannot
   rename an article. The run view shows a muted line on the task, "Updated article: <title>", with
   an undo control. A task makes at most 5 changes. Each saved add, edit or delete is one change. A
   source, a read and a failed change do not count.
2. Add a source: a text node cites a file or a web page that it read, in an article, or the user
   adds a file or a web page address on the Knowledge page. The app keeps the source. The run view
   shows one muted line for each change that a node makes.
3. Use knowledge: when a text node starts, it gets the contents list. The node opens the articles
   it needs. Each opened article shows as a compact card in the task: "Read article: <title>". A
   decision node has no knowledge tool (010).
4. Browse: "Knowledge" is a page of the workflow. A list of articles with search is on one side.
   The chosen article is on the other side, with its links, its sources and the time of the last
   change. A link opens the linked article. A link to an article that does not exist is marked.
   Where the page opens from in the workflow view is not decided (see the questions for 016).
5. Edit: the user can add, edit or delete an article, and open the sources. A source can be
   deleted, but not edited. The delete of a source is a danger button that asks first (000,
   "Danger buttons"). The user can edit articles also when knowledge is off.
6. Undo: the user undoes a change from the line in the run view or from the change list. The
   article returns to its earlier text. A deleted article returns. Undo does not look at later
   changes of the same article: it puts the earlier text back. An undo is a new change by the
   user, so the user can undo it again.
7. Check: the user presses "Check knowledge". The app finds links to missing articles, articles
   that no other article links to, and articles with no source. A source that the user deleted
   does not count as a source. With one article, the app does not report articles that no other
   article links to. The page shows these findings as a list. The check calls no model and changes
   nothing.

## States

- Empty: "No articles yet." One muted line says that the nodes of the workflow add articles as
  they work, and that the user can add one.
- The page shows, under its title, the same muted line as the memory page (see 008): how a
  workflow gets better, through the proposals that the user accepts, and that ROBot does not train
  the model. The line shows also when knowledge is off.
- Working: while a node writes, the run view shows the task as usual. The change line appears when
  the change is saved.
- Failed: a change that cannot be saved shows its error in the card. The task continues.
- Off: the list stays visible, with the muted line "Knowledge is off for this workflow." The
  switch "Knowledge is off" sits on the Knowledge page, in its header, and acts at once for that
  workflow (see the questions for 016).
- Over the limit: with 500 articles, a node cannot add more, and the button for a new article is
  off. The node tells the user in its result.
- No folder yet: the "Open folder" control is off until the first article is saved.

## Rules

- Articles and sources are plain files in a folder named "Knowledge" in the folder of the
  workflow (007). The user can open the folder from the Knowledge page and use other apps to read
  the files. This is the one place where files, not the database, are the source of truth (014).
  The app reads the folder again when it changes, also when the user changed it outside the app.
- The app creates the folder when the first article is saved.
- A folder counts as chosen by the user when it is not in the default workspace folder. A folder
  under a root that the user set in Settings is in the default workspace folder.
- In a chosen folder, the first save by a node into a missing Knowledge folder asks for approval,
  for an article or for a source. The card names the folder. A save by the user does not ask. At
  the permission level "Full access", nothing asks.
- Knowledge is local. Nothing is sent anywhere except to the model provider that a node uses.
- A node cannot edit or delete a source. A node cannot write outside the Knowledge folder with the
  knowledge tools. The general file tools of a node do not work on a source, and do not work in
  the Knowledge folder while knowledge is on. The node gets a plain error and uses the article
  tools.
- An article the user edited last is protected: before a node changes or deletes it, an approval
  card shows the new text beside the old text. Allow once and Deny are the choices. At the
  permission level "Full access", the card does not show. A change that the user made outside the
  app, and an undo, count as an edit by the user.
- The app refuses to save a text that equals a stored key or looks like a key or a token. This
  holds for an article and for a source that a node adds. The card shows a plain error. The app
  does not check a file that the user puts in the folder.
- A file in the Knowledge folder that another app wrote does not need to meet the limits for
  title, summary and body. The limits hold when the app or a node saves. A second file whose
  title is already taken is not shown, and the page says how many files it hides. Hidden files
  and folders other than "sources" are ignored.
- Memory and knowledge are separate. The user can turn knowledge off for one workflow. Existing
  articles stay, but the nodes do not read them and have no knowledge tools.
- The contents list for a node is at most 100 lines and 6,000 characters. If the whole list
  fits, the node gets all of it. If it does not fit, the app gives the lines that share words with
  the input of the node first, then the newest. After a list that is cut, one line says how many
  articles are not in it.
- A text node on a vendor runtime (006) gets the contents list and a short description of the
  folder in its instructions. It reads and writes the folder with its own file tools and its own
  permission prompts. The app reads the folder again after the task and counts the changes as the
  changes of the node. If a changed file holds a stored key or a token, the app puts back the
  earlier text, or deletes the file if it is new. The limits of 5 changes in a task and of 500
  articles are only told to the runtime in its instructions.
- The responsible document has no knowledge tool. It does not read or write articles in the chat.
- A change to an article is not a proposal of self-improvement (002). It has its own undo.
- Deleting a workflow deletes its knowledge when the Knowledge folder is in the default workspace
  folder. In a chosen folder, the app leaves the files and says so in the question that asks
  before the delete (010).
- Knowledge does not sync (019). Knowledge is part of the export (014). Sources are copied as they
  are. An import restores it.
- A workflow file (010) holds no knowledge, as it holds no memory.

## Surfaces

- **Ways in**: the tools of a text node (007), and the Knowledge page for the user.
- **Devices**: the computer shows and edits knowledge. A linked device (012) and the phone (011)
  show no Knowledge page in this version.
- **Runtimes**: a text node that uses the tools of the app uses the article tools. A text node on a
  vendor runtime (006) uses its own file tools, as "Rules" says. A decision node uses none.
- **Ways out**: undo of a change, delete of an article or a source (a source asks first), and the
  switch "Knowledge is off".
- **Seeing the state**: the Knowledge page, the change lines in the run view, and the muted line
  of an off switch. They stay after a restart.
- **Data**: see "Rules".
- **Words**: see `docs/glossary.md`.

## Out of scope

- Knowledge that several workflows share.
- Search by meaning (embeddings). Search uses words.
- A graph view of the links.
- Research that runs many nodes in parallel.
- Import from other wiki or note apps.
- Publishing articles outside the computer.
- A tool of the responsible document to read or write articles, and a check that asks a model to
  find statements that disagree (see the questions for 016).
- A skill that the app makes from an article (see the questions for 016).

## Acceptance

- A text node reads a file and writes an article that cites the file: an article appears with the
  file as its source, the run view shows a change line with undo, and the source file is
  unchanged.
- The user adds a file as a source on the Knowledge page: the app keeps a copy, and the file is
  unchanged.
- In a later run, a text node gets the contents list, opens the article and uses it. The task
  shows a "Read article" card.
- Edit an article as the user, then a node changes it: an approval card shows. Deny keeps the
  text.
- Change an article file in another app, then a node changes it: an approval card shows.
- Delete an article: a later task cannot use it. Undo the delete: it can. Undo the undo: it is
  deleted again.
- Turn knowledge off: a later task does not read the articles and has no knowledge tools. A
  decision node never has them.
- Delete an article that another article links to: "Check knowledge" reports the broken link, and
  no model is called.
- A node saves a stored key in an article: the change fails and the file does not hold the key.
- A node adds a file that holds a stored key as a source: the change fails and no source is
  saved. After an export, the archive holds no stored key.
- A task asks for 6 article changes: 5 are saved, and the sixth fails with a plain error in its
  card.
- Ask the chat for an article: the responsible document has no tool for it and says so.
- Two workflows: each has its own articles, and a node of one cannot read the other's.
- Delete a workflow with its folder in the default workspace folder: its knowledge is deleted.
  Delete a workflow with a chosen folder: the files stay, and the question said so.
- Two computers in sync (019): the articles stay on the computer that holds them. An export holds
  the articles and the sources.
