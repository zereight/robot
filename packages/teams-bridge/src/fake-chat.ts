/**
 * A fake chat page for tests. It uses the guessed selectors of selectors.ts.
 * It shows that the reader and the sender work with those selectors.
 * It shows nothing about the real Teams page.
 */
export const fakeChatHtml = String.raw`<html>
  <body>
    <h2 data-tid="chat-title">Fake Person (You)</h2>
    <div id="list">
      <div data-tid="chat-pane-message" data-mid="1">
        <span data-tid="message-author-name">Me</span>
        <time datetime="2026-11-03T10:00:00Z"></time>
        <div data-tid="message-body">first</div>
      </div>
      <div data-tid="chat-pane-message" data-mid="2">
        <span data-tid="message-author-name">Me</span>
        <time datetime="2026-11-03T10:01:00Z"></time>
        <div data-tid="message-body">line one<br />line two</div>
      </div>
    </div>
    <div data-tid="ckeditor" contenteditable="true" id="box"></div>
    <script>
      let next = 3;
      const box = document.getElementById("box");
      box.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        if (e.shiftKey) {
          document.execCommand("insertLineBreak");
          return;
        }
        const el = document.createElement("div");
        el.setAttribute("data-tid", "chat-pane-message");
        el.setAttribute("data-mid", String(next++));
        el.innerHTML =
          '<span data-tid="message-author-name">Me</span><time datetime="2026-11-03T10:02:00Z"></time><div data-tid="message-body"></div>';
        el.querySelector('[data-tid="message-body"]').innerText = box.innerText.replace(/\n$/, "");
        document.getElementById("list").appendChild(el);
        box.innerHTML = "";
      });
    </script>
  </body>
</html>
`
