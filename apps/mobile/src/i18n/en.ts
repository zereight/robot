/** English catalogue of the phone. It is the source: every key here is in every other catalogue. */
export const en = {
  "common.cancel": "Cancel",
  "common.close": "Close",
  "common.continue": "Continue",
  "common.openSettings": "Open settings",

  "welcome.title": "Welcome to ROBot",
  "welcome.body": "Your computers run the workflows. This phone connects to them.",
  "welcome.name.label": "Name of this phone",
  "welcome.name.hint": "Your computer shows this name when you pair.",
  "welcome.name.placeholder": "My phone",
  "welcome.localNetwork":
    "ROBot connects straight to your computer on your network. If the phone asks whether ROBot may use the local network, say yes: it needs this to reach the computer.",

  "pair.title": "Pair with a computer",
  "pair.scan.hint":
    "On the computer, open Settings → Devices → Pair a device. Then point the camera at the QR code.",
  "pair.typeInstead": "Type it instead",
  "pair.scanInstead": "Scan the QR code",
  "pair.camera.ask": "ROBot needs the camera to read the QR code.",
  "pair.camera.allow": "Allow the camera",
  "pair.camera.denied":
    "The camera is not allowed. Turn it on in the system settings, or type the address and the code.",
  "pair.address.label": "Address",
  "pair.address.placeholder": "192.168.1.4:47800",
  "pair.address.hint": "The pairing screen of the computer shows its addresses.",
  "pair.code.label": "6-digit code",
  "pair.code.placeholder": "123 456",
  "pair.submit": "Pair",
  "pair.checking": "Checking the code…",
  "pair.checking.hint": "On a phone this can take up to half a minute.",
  "pair.waiting": "Waiting for {name} to allow…",
  "pair.waiting.hint": "On {name}, choose Allow.",
  "pair.vpn":
    "To use the phone away from this network, put the phone and the computer in one VPN, for example Tailscale.",
  "pair.localNetwork":
    "The phone may ask whether ROBot can use the local network. Say yes: ROBot needs it to reach the computer.",

  "error.wrong_code": "The code is not right. Check the code on the computer.",
  "error.code_ended": "This code has ended. Make a new code on the computer.",
  "error.unreachable":
    "The computer is not reachable. Check that the phone and the computer are on one network or in one VPN.",
  "error.not_accepting":
    "The computer does not accept connections. Turn on “Let other devices connect” on the computer.",
  "error.same_device": "This is the same device. Pair with a computer.",
  "error.denied": "The computer did not allow this phone.",
  "error.limit":
    "The limit is reached: 10 devices can open a computer, and a phone opens 10 servers.",
  "error.update_app.this": "Update the app on this phone.",
  "error.update_app.server": "Update the app on the computer.",
  "error.invalid_link": "This QR code is not a pairing code of ROBot.",
  "error.invalid_address": "This is not an address. Use a form like 192.168.1.4:47800.",
  "error.invalid_name": "Type a name for this phone.",
  "error.offline": "The server is offline.",
  "error.timeout": "The server did not answer in time.",
  "error.not_allowed": "Not allowed. Open this on the computer.",
  "error.file_too_large": "{detail} is larger than 20 MB.",
  "error.too_many_files": "You can attach at most 10 files to one message.",
  "error.file_unreadable": "{detail} could not be read.",
  "error.generic": "This did not work. ({code})",

  "servers.title": "Servers",
  "servers.add": "Add server",
  "servers.empty.title": "No computer yet",
  "servers.empty.body": "Pair this phone with a computer that runs ROBot.",
  "servers.settings": "Settings",
  "servers.pairAgain": "Pair again",
  "servers.localNetwork":
    "Cannot reach a computer on this network? Check that ROBot may use the local network: Settings → Privacy & Security → Local Network.",
  "servers.row": "{name}, {state}",

  "state.connecting": "Connecting…",
  "state.online": "Online",
  "state.reconnecting": "Reconnecting",
  "state.offline": "Offline",
  "state.not_allowed": "{name} removed this device.",
  "state.update_app.this": "Update the app on this phone.",
  "state.update_app.server": "Update the app on {name}.",

  "file.size.b": "{n} B",
  "file.size.kb": "{n} KB",
  "file.size.mb": "{n} MB",

  "settings.title": "Settings",
  "settings.language": "Language",
  "settings.language.system": "Follow the system",
  "settings.language.en": "English",
  "settings.language.ko": "한국어",
  "settings.theme": "Theme",
  "settings.theme.system": "System",
  "settings.theme.dark": "Dark",
  "settings.theme.light": "Light",
  "settings.servers": "Servers",
  "settings.servers.empty": "This phone is not paired with a computer.",
  "settings.unpair": "Unpair",
  "settings.unpair.title": "Unpair {name}?",
  "settings.unpair.body":
    "This phone forgets {name} and deletes what it saved of it. {name} keeps this phone in its list until you remove it there.",
  "settings.device": "This phone",
  "settings.device.hint": "Computers show this name.",

  "server.soon": "The workflows of this computer come to the phone later.",
} as const

export type MessageKey = keyof typeof en
