import {
  type AsyncSecretStore,
  type BrowserWebSocketClass,
  browserSocket,
  codeToWAsync,
} from "@robot/link"
import type { PhoneStorage } from "@robot/phone"
import * as Crypto from "expo-crypto"
import { Directory, File, Paths } from "expo-file-system"
import * as SecureStore from "expo-secure-store"

/**
 * Secure random bytes from the system (spec 012). The app never uses `Math.random` for a key, a
 * nonce or an id.
 */
export const secureRandom = (length: number): Uint8Array =>
  Crypto.getRandomValues(new Uint8Array(length))

/**
 * The identity key lives only in the secure store of the system: the Keychain on iPhone, the
 * Keystore on Android. It is readable only while the phone is unlocked, and it does not move to
 * another phone with a backup.
 */
export const secureSecrets: AsyncSecretStore = {
  get: (key) =>
    SecureStore.getItemAsync(key, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    }),
  set: (key, value) =>
    SecureStore.setItemAsync(key, value, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    }),
}

/** The files of the app: under "robot" in the documents folder of the app. */
export const fileStorage = (): PhoneStorage => {
  const root = new Directory(Paths.document, "robot")
  // A path never leaves the folder: "." and ".." are dropped.
  const at = (path: string) => path.split("/").filter((n) => n && n !== "." && n !== "..")
  const fileOf = (path: string) => new File(root, ...at(path))
  return {
    async read(path) {
      const file = fileOf(path)
      return file.exists ? file.text() : null
    },
    async write(path, text) {
      const names = at(path)
      const folder = new Directory(root, ...names.slice(0, -1))
      if (!folder.exists) folder.create({ intermediates: true })
      const file = new File(folder, names.at(-1) ?? "")
      file.write(text)
    },
    async remove(path) {
      const names = at(path)
      if (names.length === 0) return
      const file = new File(root, ...names)
      if (file.exists) {
        file.delete()
        return
      }
      const folder = new Directory(root, ...names)
      if (folder.exists) folder.delete()
    },
  }
}

/** Opens a plain web socket (`ws://`) with the WebSocket of React Native. */
export const socketOpener = browserSocket(globalThis.WebSocket as unknown as BrowserWebSocketClass)

/** The key of the pairing code. scrypt runs in steps, so the screen does not freeze. */
export const deriveW = (code: string) => codeToWAsync(code)
