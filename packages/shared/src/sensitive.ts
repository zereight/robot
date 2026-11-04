/**
 * Sensitive places (spec 007, "Sensitive places"). Two fixed lists name the places: credential
 * places, which hold keys and logins, and control places, which start a program later or give
 * access to the computer. A step that reads a credential place is a sensitive read. A step that
 * writes a control place is a hard step.
 *
 * The lists work from a home folder that the caller gives, so a test can use its own folder. This
 * file runs in the window too, so it does not use the path module of Node: the caller gives the
 * function that finds a real path.
 */

/** The labels of the credential places. The app shows a translated text for each one. */
export const SENSITIVE_LABELS = [
  "keys",
  "cloud",
  "tools",
  "history",
  "keychain",
  "browser",
  "robot",
] as const
export type SensitiveLabel = (typeof SENSITIVE_LABELS)[number]

export const isSensitiveLabel = (value: unknown): value is SensitiveLabel =>
  typeof value === "string" && (SENSITIVE_LABELS as readonly string[]).includes(value)

/**
 * The credential places in the home folder, by label (spec 007). The label "robot" is the data
 * folder of ROBot, which the caller names. A name that ends in a slash is a folder; the others
 * are a file or a folder, and a folder covers everything inside it.
 */
export const CREDENTIAL_HOME_PLACES: Readonly<Record<Exclude<SensitiveLabel, "robot">, string[]>> =
  {
    // The folders of SSH keys and GnuPG keys.
    keys: [".ssh", ".gnupg"],
    // The logins of cloud tools and cluster tools: Amazon Web Services, Google Cloud, Azure,
    // Kubernetes.
    cloud: [".aws", ".config/gcloud", ".azure", ".kube"],
    // The netrc file, the Git credentials file, the npm settings file, the Docker settings file,
    // and the settings of the GitHub command line tool.
    tools: [
      ".netrc",
      "_netrc",
      ".git-credentials",
      ".config/git/credentials",
      ".npmrc",
      ".docker/config.json",
      ".config/gh",
    ],
    // The history files of shells.
    history: [
      ".bash_history",
      ".zsh_history",
      ".zhistory",
      ".sh_history",
      ".history",
      ".zsh_sessions",
      ".local/share/fish/fish_history",
      ".config/fish/fish_history",
      ".node_repl_history",
    ],
    // The keychains of the user.
    keychain: ["Library/Keychains"],
    // The profile folders of web browsers.
    browser: [
      "Library/Application Support/Google/Chrome",
      "Library/Application Support/Google/Chrome Beta",
      "Library/Application Support/Google/Chrome Canary",
      "Library/Application Support/Chromium",
      "Library/Application Support/BraveSoftware",
      "Library/Application Support/Microsoft Edge",
      "Library/Application Support/Vivaldi",
      "Library/Application Support/Arc",
      "Library/Application Support/Firefox",
      "Library/Application Support/com.operasoftware.Opera",
      "Library/Safari",
      "Library/Cookies",
      "Library/Containers/com.apple.Safari",
    ],
  }

/** The start files of shells in the home folder. */
const SHELL_START_FILES = [
  ".zshenv",
  ".zprofile",
  ".zshrc",
  ".zlogin",
  ".zlogout",
  ".bashrc",
  ".bash_profile",
  ".bash_login",
  ".bash_logout",
  ".profile",
  ".cshrc",
  ".tcshrc",
  ".login",
  ".kshrc",
  ".config/fish/config.fish",
  ".config/fish/conf.d",
]

/**
 * The control places in the home folder: the start files of shells, the folders of login items
 * and background items, the SSH folder (it holds the file of allowed keys), and the settings
 * folders of other agent programs with their files that list MCP servers.
 */
export const CONTROL_HOME_PLACES: readonly string[] = [
  ...SHELL_START_FILES,
  "Library/LaunchAgents",
  "Library/LaunchDaemons",
  ".ssh",
  // Other agent programs: Claude Code, Codex, Cursor, Gemini, and the programs that ROBot runs
  // as agent runtimes (006) or that are well known.
  ".claude",
  ".claude.json",
  ".codex",
  ".cursor",
  ".gemini",
  ".pi",
  ".config/opencode",
  ".opencode",
  ".windsurf",
  ".codeium",
  ".continue",
  "Library/Application Support/Claude/claude_desktop_config.json",
]

/** The control places of the system. A link such as `/etc` is followed by the real path. */
export const CONTROL_SYSTEM_PLACES: readonly string[] = [
  "/Library/LaunchAgents",
  "/Library/LaunchDaemons",
  "/System/Library/LaunchAgents",
  "/System/Library/LaunchDaemons",
  "/etc/hosts",
  "/etc/sudoers",
  "/etc/sudoers.d",
]

/** What the lists need to know about this computer. A test gives its own. */
export interface PlaceEnv {
  /** The home folder. A test gives a folder of its own. */
  readonly home: string
  /**
   * The real path of a path, with every link followed. A path that does not exist keeps its
   * last names after the real path of the nearest folder that exists.
   */
  readonly real: (path: string) => string
  /**
   * The data folder of ROBot (014), and the folders inside it that are not data of ROBot: the
   * workspaces of agents. Left out, the label "robot" matches nothing.
   */
  readonly data?: { readonly folder: string; readonly except: readonly string[] }
}

/** Folds `.` and `..` away and returns the names of a path. */
const names = (path: string): string[] => {
  const out: string[] = []
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") out.pop()
    else out.push(part)
  }
  return out
}

/** A path as a list of names in lower case, because a disk can ignore case. */
const folded = (path: string): string[] => names(path).map((n) => n.toLowerCase())

const startsWith = (path: readonly string[], root: readonly string[]) =>
  root.length > 0 && root.every((name, i) => path[i] === name)

/** The path of a place under a folder. */
const under = (folder: string, relative: string) => `${folder.replace(/\/+$/, "")}/${relative}`

export interface Places {
  /** The label of the credential place that holds the path, or null. */
  credential(path: string): SensitiveLabel | null
  /** True when the path is a control place, or inside one. */
  control(path: string): boolean
  /** The path of a word of a command, with `~` and `$HOME` read as the home folder. */
  expand(word: string, cwd: string): string | null
}

/**
 * The two lists for one home folder. Each place is compared by real path: both the place and the
 * path that a step names go through `real`, so a link cannot reach a place that the list names.
 */
export const makePlaces = (env: PlaceEnv): Places => {
  const credentials: { label: SensitiveLabel; root: string[] }[] = []
  for (const label of Object.keys(CREDENTIAL_HOME_PLACES) as Exclude<SensitiveLabel, "robot">[])
    for (const relative of CREDENTIAL_HOME_PLACES[label])
      credentials.push({ label, root: folded(env.real(under(env.home, relative))) })
  const dataRoot = env.data ? folded(env.real(env.data.folder)) : []
  const data = env.data
    ? {
        root: dataRoot,
        // Only a folder inside the data folder is apart from it. A workspace that holds the data
        // folder, for example the home folder, must not take the data folder out of the list.
        except: env.data.except
          .map((e) => folded(env.real(e)))
          .filter((e) => startsWith(e, dataRoot)),
      }
    : undefined
  const controls: string[][] = [
    ...CONTROL_HOME_PLACES.map((relative) => folded(env.real(under(env.home, relative)))),
    ...CONTROL_SYSTEM_PLACES.map((place) => folded(env.real(place))),
  ]
  return {
    credential: (path) => {
      const target = folded(env.real(path))
      for (const place of credentials) if (startsWith(target, place.root)) return place.label
      if (data && startsWith(target, data.root) && !data.except.some((e) => startsWith(target, e)))
        return "robot"
      return null
    },
    control: (path) => {
      const target = folded(env.real(path))
      if (controls.some((root) => startsWith(target, root))) return true
      // The hook folder and the settings file of a Git repository, in any folder.
      // A submodule keeps its own repository in `.git/modules`.
      for (let git = target.indexOf(".git"); git >= 0; git = target.indexOf(".git", git + 1)) {
        const next = target[git + 1]
        if (next === "hooks" || (next === "config" && target.length === git + 2)) return true
        if (next === "modules") {
          const rest = target.slice(git + 2)
          if (rest.includes("hooks") || rest[rest.length - 1] === "config") return true
        }
      }
      return false
    },
    expand: (word, cwd) => {
      const w = word.trim()
      if (!w) return null
      const home = /^(?:~|\$HOME|\$\{HOME\})(?:\/(.*))?$/.exec(w)
      if (home) return home[1] ? under(env.home, home[1]) : env.home
      // A word with another variable, or a command, cannot be read.
      if (/[$`*?[{]/.test(w) || w.startsWith("~")) return null
      if (w.startsWith("/")) return w
      return under(cwd, w)
    },
  }
}

// ---------------------------------------------------------------------------------------------
// The text of a command.
// ---------------------------------------------------------------------------------------------

/** One piece of a command: a word with its quotes read, or an operator. */
export type CommandToken =
  | { readonly kind: "word"; readonly text: string }
  | { readonly kind: "op"; readonly text: string }

/**
 * Splits a command into words and operators. Quotes and escapes group a word and are dropped.
 * Operators: `;`, `&`, `&&`, `|`, `||`, line ends, `(`, `)`, a back quote, and the redirections
 * `>`, `>>`, `>|`, `&>`, `&>>` with a file descriptor before them. `>&2` and `<&3` are not
 * redirections to a file, so they are dropped.
 */
export const lexCommand = (command: string): CommandToken[] => {
  const out: CommandToken[] = []
  let word = ""
  let inWord = false
  const flush = () => {
    if (inWord) out.push({ kind: "word", text: word })
    word = ""
    inWord = false
  }
  const op = (text: string) => {
    flush()
    out.push({ kind: "op", text })
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i] as string
    if (c === "\\" && i + 1 < command.length) {
      word += command[++i]
      inWord = true
    } else if (c === "'") {
      const end = command.indexOf("'", i + 1)
      const stop = end < 0 ? command.length : end
      word += command.slice(i + 1, stop)
      inWord = true
      i = stop
    } else if (c === '"') {
      inWord = true
      let j = i + 1
      for (; j < command.length && command[j] !== '"'; j++) {
        if (command[j] === "\\" && j + 1 < command.length) j++
        word += command[j]
      }
      i = j
    } else if (/\s/.test(c)) {
      if (c === "\n") op(";")
      else flush()
    } else if (c === ";" || c === "(" || c === ")" || c === "`") {
      op(";")
    } else if (c === "|") {
      if (command[i + 1] === "|") i++
      op("|")
    } else if (c === "&" && command[i + 1] === ">") {
      const append = command[i + 2] === ">"
      i += append ? 2 : 1
      op(append ? ">>" : ">")
    } else if (c === "&") {
      if (command[i + 1] === "&") i++
      op(";")
    } else if (c === ">" || c === "<") {
      // A file descriptor right before the operator belongs to it: `2>file`.
      if (inWord && /^\d+$/.test(word)) {
        word = ""
        inWord = false
      }
      let text = c
      if (command[i + 1] === c) {
        text += c
        i++
      } else if (c === ">" && command[i + 1] === "|") {
        i++
      }
      // `>&2`, `<&3`, `>&-`: a copy of a descriptor, not a file.
      if (command[i + 1] === "&" && /[\d-]/.test(command[i + 2] ?? "")) {
        flush()
        i += 2
        while (/\d/.test(command[i + 1] ?? "")) i++
        continue
      }
      op(text)
    } else {
      word += c
      inWord = true
    }
  }
  flush()
  return out
}

/** The simple commands of a command line: the words between operators that join commands. */
export const simpleCommands = (tokens: readonly CommandToken[]): string[][] => {
  const out: string[][] = []
  let current: string[] = []
  const end = () => {
    if (current.length > 0) out.push(current)
    current = []
  }
  for (const token of tokens) {
    if (token.kind === "word") current.push(token.text)
    else if (token.text === ";" || token.text === "|") end()
  }
  end()
  return out
}

/** Words that run the next word as a command. */
const WRAPPERS = new Set([
  "sudo",
  "env",
  "command",
  "nohup",
  "time",
  "exec",
  "xargs",
  "nice",
  "doas",
])

/**
 * The program and its arguments of a simple command: variables set before it and wrapper words
 * such as `sudo` are skipped, and the program is named without its folder.
 */
const programOf = (words: readonly string[]): { name: string; args: string[] } | null => {
  let i = 0
  while (i < words.length) {
    const word = words[i] as string
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || WRAPPERS.has(word) || /^-/.test(word)) i++
    else break
  }
  const first = words[i]
  if (first === undefined) return null
  return { name: first.split("/").pop() ?? first, args: words.slice(i + 1) }
}

/** The files that a command writes with `>`, `>>` or `tee`, as the words that name them. */
export const redirectTargets = (command: string): string[] => {
  const tokens = lexCommand(command)
  const out: string[] = []
  for (const [i, token] of tokens.entries()) {
    if (token.kind === "op" && (token.text === ">" || token.text === ">>")) {
      const next = tokens[i + 1]
      if (next?.kind === "word") out.push(next.text)
    }
  }
  for (const words of simpleCommands(tokens)) {
    const program = programOf(words)
    if (program?.name !== "tee") continue
    for (const arg of program.args) if (!arg.startsWith("-")) out.push(arg)
  }
  return out
}

/** The subcommands of `launchctl` that load a login item or a background item. */
const LAUNCHCTL_LOADS = new Set(["load", "bootstrap", "enable", "submit"])

/**
 * True when a command loads a login item or a background item (`launchctl` with `load`,
 * `bootstrap`, `enable` or `submit`), or edits the timed jobs of the user (`crontab` with an
 * option other than `-l`, or a file, or no argument, which reads the jobs from the input).
 */
export const changesStartups = (command: string): boolean => {
  for (const words of simpleCommands(lexCommand(command))) {
    const program = programOf(words)
    if (!program) continue
    if (program.name === "launchctl") {
      const sub = program.args.find((a) => !a.startsWith("-"))
      if (sub !== undefined && LAUNCHCTL_LOADS.has(sub)) return true
    } else if (program.name === "crontab") {
      let list = false
      let other = false
      for (const [i, arg] of program.args.entries()) {
        if (program.args[i - 1] === "-u") continue
        if (arg === "-l") list = true
        else if (arg !== "-u") other = true
      }
      if (other || !list) return true
    }
  }
  return false
}

/**
 * The subcommands of `security` that print a password or dump a keychain. The two `find` commands
 * print the password only with `-w` or `-g`.
 */
export const readsKeychain = (command: string): boolean => {
  for (const words of simpleCommands(lexCommand(command))) {
    const program = programOf(words)
    if (program?.name !== "security") continue
    const sub = program.args.find((a) => !a.startsWith("-"))
    if (sub === "dump-keychain" || sub === "export") return true
    if (sub === "find-generic-password" || sub === "find-internet-password")
      return program.args.some((a) => /^-[a-zA-Z]*[wg][a-zA-Z]*$/.test(a))
  }
  return false
}

/**
 * Makes the text of a command ready for a search of place names: quotes and escapes go, a
 * variable of the home folder has one form, and `//`, `/./` and `x/../` fold away.
 */
const flatten = (command: string): string => {
  let text = command
    .replace(/\\(.)/g, "$1")
    .replace(/["'`]/g, "")
    .replace(/\$\{HOME\}/g, "$HOME")
  for (let n = 0; n < 8; n++) {
    const next = text
      .replace(/\/{2,}/g, "/")
      .replace(/\/\.(?=\/|$|\s)/g, "")
      .replace(/\/[^/\s]+\/\.\.(?=\/|$|\s)/g, "")
    if (next === text) break
    text = next
  }
  return text.toLowerCase()
}

/** True when `char` cannot be part of a name in a path. */
const isBoundary = (char: string | undefined) => char === undefined || !/[a-z0-9_.-]/i.test(char)

/** True when `char`, before a path, shows that the path starts here and is not a part of another. */
const startsPath = (char: string | undefined) => char === undefined || !/[a-z0-9_.\-/]/i.test(char)

/** The ways that the text of a command can write the path of a place, in lower case. */
const variantsOf = (env: PlaceEnv, path: string): string[] => {
  const out = new Set<string>()
  const clean = (p: string) => p.replace(/\/+$/, "").toLowerCase()
  const add = (p: string) => out.add(clean(p))
  for (const form of [path, env.real(path)]) add(form)
  for (const [home, form] of [
    [env.home, path],
    [env.real(env.home), env.real(path)],
  ] as const) {
    const root = clean(home)
    const at = clean(form)
    if (at === root || at.startsWith(`${root}/`)) {
      const rest = at.slice(root.length)
      out.add(`~${rest}`)
      out.add(`$home${rest}`)
    }
  }
  return [...out]
}

/** True when the flat text holds `variant` as a whole path: it starts a path and ends at a name boundary. */
const holdsPath = (text: string, variant: string): number => {
  for (let at = text.indexOf(variant); at >= 0; at = text.indexOf(variant, at + 1))
    if (startsPath(text[at - 1]) && isBoundary(text[at + variant.length])) return at
  return -1
}

/**
 * The label of the first credential place that the text of a command names, or null. The text
 * names a place with `~`, `$HOME` or the full path. A command can hide a path, for example in a
 * variable, so this is a help and not a wall. It also finds a command that prints a password
 * from a keychain.
 */
export const commandReads = (env: PlaceEnv, command: string): SensitiveLabel | null => {
  if (readsKeychain(command)) return "keychain"
  const text = flatten(command)
  for (const label of Object.keys(CREDENTIAL_HOME_PLACES) as Exclude<SensitiveLabel, "robot">[])
    for (const relative of CREDENTIAL_HOME_PLACES[label])
      for (const variant of variantsOf(env, under(env.home, relative)))
        if (holdsPath(text, variant) >= 0) return label
  if (env.data) {
    const data = env.data
    for (const variant of variantsOf(env, data.folder)) {
      const at = holdsPath(text, variant)
      if (at < 0) continue
      // A folder inside the data folder that holds no data of ROBot, such as the workspaces.
      const rest = text.slice(at + variant.length)
      const apart = data.except.some((folder) =>
        variantsOf(env, folder).some((exempt) => {
          if (!exempt.startsWith(variant)) return false
          const tail = exempt.slice(variant.length)
          return rest.startsWith(tail) && isBoundary(rest[tail.length])
        }),
      )
      if (!apart) return "robot"
    }
  }
  return null
}

/**
 * True when a command writes a control place with `>`, `>>` or `tee`, or loads a login item or a
 * background item, or edits the timed jobs of the user. `cwd` is the folder where the command
 * runs, for a name with no folder.
 */
export const commandChangesControl = (env: PlaceEnv, command: string, cwd: string): boolean => {
  if (changesStartups(command)) return true
  const places = makePlaces(env)
  for (const word of redirectTargets(command)) {
    const path = places.expand(word, cwd)
    if (path && places.control(path)) return true
  }
  return false
}

// ---------------------------------------------------------------------------------------------
// The steps of a tool.
// ---------------------------------------------------------------------------------------------

/** The sensitive read in a file step: a read, a list or a search of a credential place. */
export const fileReads = (env: PlaceEnv, path: string): SensitiveLabel | null =>
  makePlaces(env).credential(path)
