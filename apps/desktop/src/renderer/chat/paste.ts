/**
 * The files of a paste that the message box attaches (spec 003, flow 4). The rest of the paste
 * stays what the browser makes of it: text in the text box.
 *
 * - No file on the clipboard: nothing to attach, and the text pastes as it always did.
 * - A file with a path on disk (copied in the file manager): attach it. The file manager also puts
 *   the name of the file on the clipboard as text, and the text must not win.
 * - A file with no path (a screenshot, a picture or a video that was copied): attach it when the
 *   clipboard holds no text. When it holds text too, the user copied something like a table, and
 *   the picture is only a drawing of it. The text pastes.
 */
export const pastedFiles = (
  files: readonly File[],
  text: string,
  hasPath: (file: File) => boolean,
): File[] => {
  if (files.length === 0) return []
  if (text.length > 0 && !files.some(hasPath)) return []
  return [...files]
}
