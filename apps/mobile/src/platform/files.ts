import type { PhoneHub, UploadSource } from "@robot/phone"
import * as DocumentPicker from "expo-document-picker"
import { Directory, File, Paths } from "expo-file-system"
import * as ImagePicker from "expo-image-picker"
import * as Sharing from "expo-sharing"

/** A file that the user picked, before it is sent. */
export interface Picked {
  readonly id: string
  readonly name: string
  readonly size: number
  readonly uri: string
}

const sizeOf = (uri: string, given: number | null | undefined) => {
  if (typeof given === "number" && given >= 0) return given
  try {
    return new File(uri).size ?? 0
  } catch {
    return 0
  }
}

/** A name with no folders, so a picked name never names a path. */
const plainName = (name: string, fallback: string) => name.split(/[\\/]/).pop()?.trim() || fallback

/** Photos from the library of the phone. */
export const pickPhotos = async (): Promise<Picked[]> => {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsMultipleSelection: true,
    quality: 1,
  })
  if (result.canceled) return []
  return result.assets.map((a, i) => ({
    id: `${a.uri}#${i}`,
    name: plainName(a.fileName ?? "", a.uri.split("/").pop() ?? `photo-${i + 1}.jpg`),
    size: sizeOf(a.uri, a.fileSize),
    uri: a.uri,
  }))
}

/** Files from the files app of the system. They are copied into the cache of the app first. */
export const pickFiles = async (): Promise<Picked[]> => {
  const result = await DocumentPicker.getDocumentAsync({
    multiple: true,
    copyToCacheDirectory: true,
  })
  if (result.canceled) return []
  return result.assets.map((a, i) => ({
    id: `${a.uri}#${i}`,
    name: plainName(a.name, `file-${i + 1}`),
    size: sizeOf(a.uri, a.size),
    uri: a.uri,
  }))
}

/** Reads a picked file in pieces for the upload of the link (spec 012). */
export const uploadSource = (picked: Picked): UploadSource => ({
  name: picked.name,
  size: picked.size,
  read: async (offset, length) => {
    const handle = new File(picked.uri).open()
    try {
      handle.offset = offset
      return await handle.readBytes(length)
    } finally {
      handle.close()
    }
  },
})

/**
 * Reads a file of a message from the server into the cache of the app, then opens it: the
 * preview of the system when it can show the file, else the share sheet ("Open in…").
 */
export const downloadAndOpen = async (
  hub: PhoneHub,
  linkId: string,
  file: { readonly agentId: string; readonly path: string; readonly name: string },
) => {
  const folder = new Directory(Paths.cache, "downloads", linkId.replace(/[^\w-]/g, "_"))
  if (!folder.exists) folder.create({ intermediates: true })
  const target = new File(folder, plainName(file.name, "file"))
  if (target.exists) target.delete()
  target.create()
  const handle = target.open()
  try {
    await hub.download(linkId, { agentId: file.agentId, path: file.path }, (bytes) =>
      handle.writeBytes(bytes),
    )
  } finally {
    handle.close()
  }
  if (await target.canPreview().catch(() => false)) {
    await target.preview()
    return
  }
  if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(target.uri)
}

/** Deletes the files that the phone read from a server, after unpair or "Not allowed". */
export const forgetDownloads = (linkId: string) => {
  const folder = new Directory(Paths.cache, "downloads", linkId.replace(/[^\w-]/g, "_"))
  if (folder.exists) folder.delete()
}
