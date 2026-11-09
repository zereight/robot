//! The main process calls this part as a short command, and waits for it:
//!
//! ```text
//! robot-host secrets get <key> --vault <path> --profile <id>      the value on stdout
//! robot-host secrets set <key> --vault <path> --profile <id>      the value on stdin
//! robot-host secrets remove <key> --vault <path> --profile <id>   no error when there is none
//! robot-host secrets check --vault <path> --profile <id>          the vault can be used
//! robot-host secrets destroy --vault <path> --profile <id>        removes the file and the key
//! robot-host secrets get|set|remove <key> --file <path>           tests only
//! robot-host secrets check|destroy --file <path>                  tests only
//! ```
//!
//! Exit codes: 0 done, 1 the store failed (the reason on stderr, never a value), 2 bad
//! arguments, 3 no value. `check` and `destroy` never exit with 3.

use std::collections::BTreeMap;
use std::fmt;
use std::io::{Read, Write};
use std::path::PathBuf;

use crate::vault::{KeySource, KeychainKeys, SERVICE, Vault, VaultError};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreError(pub String);

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

pub trait Store {
    fn get(&self, key: &str) -> Result<Option<String>, StoreError>;
    fn set(&self, key: &str, value: &str) -> Result<(), StoreError>;
    /// Removing a key that has no value is not an error.
    fn remove(&self, key: &str) -> Result<(), StoreError>;
    /// Proves the store can be used. Never makes a key or a file.
    fn check(&self) -> Result<(), StoreError>;
    /// Removes the store itself. A missing store is success.
    fn destroy(&self) -> Result<(), StoreError>;
}

/// The values in one JSON object in a file. For end-to-end tests only.
pub struct FileStore {
    pub path: PathBuf,
}

impl FileStore {
    fn read(&self) -> Result<BTreeMap<String, String>, StoreError> {
        match std::fs::read_to_string(&self.path) {
            Ok(text) => serde_json::from_str(&text).map_err(|e| StoreError(e.to_string())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
            Err(e) => Err(StoreError(e.to_string())),
        }
    }

    fn write(&self, values: &BTreeMap<String, String>) -> Result<(), StoreError> {
        let text = serde_json::to_string(values).map_err(|e| StoreError(e.to_string()))?;
        std::fs::write(&self.path, text).map_err(|e| StoreError(e.to_string()))
    }
}

impl Store for FileStore {
    fn get(&self, key: &str) -> Result<Option<String>, StoreError> {
        Ok(self.read()?.remove(key))
    }

    fn set(&self, key: &str, value: &str) -> Result<(), StoreError> {
        let mut values = self.read()?;
        values.insert(key.to_owned(), value.to_owned());
        self.write(&values)
    }

    fn remove(&self, key: &str) -> Result<(), StoreError> {
        let mut values = self.read()?;
        if values.remove(key).is_some() {
            self.write(&values)?;
        }
        Ok(())
    }

    fn check(&self) -> Result<(), StoreError> {
        self.read().map(|_| ())
    }

    fn destroy(&self) -> Result<(), StoreError> {
        match std::fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(StoreError(e.to_string())),
        }
    }
}

fn vault_reason(error: &VaultError) -> String {
    match error {
        VaultError::Keychain(code) => format!("keychain error {code}"),
        VaultError::Corrupt(_) => "secrets file is corrupt".into(),
        VaultError::Io(reason) => reason.clone(),
    }
}

impl<K: KeySource> Store for Vault<K> {
    fn get(&self, key: &str) -> Result<Option<String>, StoreError> {
        self.get(key).map_err(|e| StoreError(vault_reason(&e)))
    }

    fn set(&self, key: &str, value: &str) -> Result<(), StoreError> {
        self.set(key, value)
            .map_err(|e| StoreError(vault_reason(&e)))
    }

    fn remove(&self, key: &str) -> Result<(), StoreError> {
        self.remove(key).map_err(|e| StoreError(vault_reason(&e)))
    }

    fn check(&self) -> Result<(), StoreError> {
        self.check().map_err(|e| StoreError(vault_reason(&e)))
    }

    fn destroy(&self) -> Result<(), StoreError> {
        self.destroy().map_err(|e| StoreError(vault_reason(&e)))
    }
}

pub const EXIT_DONE: u8 = 0;
pub const EXIT_FAILED: u8 = 1;
pub const EXIT_USAGE: u8 = 2;
pub const EXIT_NONE: u8 = 3;

enum Op {
    Get,
    Set,
    Remove,
    Check,
    Destroy,
}

enum Locator {
    Vault { path: PathBuf, profile: String },
    File { path: PathBuf },
}

struct Command {
    op: Op,
    key: Option<String>,
    locator: Locator,
}

fn parse(args: &[String]) -> Result<Command, String> {
    let op = match args.first().map(String::as_str) {
        Some("get") => Op::Get,
        Some("set") => Op::Set,
        Some("remove") => Op::Remove,
        Some("check") => Op::Check,
        Some("destroy") => Op::Destroy,
        _ => return Err("give get, set, remove, check or destroy".into()),
    };
    let mut at = 1;
    let key = if matches!(op, Op::Get | Op::Set | Op::Remove) {
        let key = args
            .get(at)
            .filter(|key| !key.is_empty() && !key.starts_with("--"));
        at += 1;
        Some(key.ok_or("give a key")?.clone())
    } else if args.get(at).is_some_and(|next| !next.starts_with("--")) {
        return Err("check and destroy take no key".into());
    } else {
        None
    };
    let mut file: Option<PathBuf> = None;
    let mut vault: Option<PathBuf> = None;
    let mut profile: Option<String> = None;
    while at < args.len() {
        match args[at].as_str() {
            "--file" => {
                at += 1;
                file = Some(PathBuf::from(args.get(at).ok_or("--file needs a path")?));
            }
            "--vault" => {
                at += 1;
                let path = args.get(at).ok_or("--vault needs a path")?;
                if path.is_empty() {
                    return Err("--vault needs a path".into());
                }
                vault = Some(PathBuf::from(path));
            }
            "--profile" => {
                at += 1;
                let id = args.get(at).ok_or("--profile needs an id")?;
                if id.is_empty() {
                    return Err("--profile needs an id".into());
                }
                profile = Some(id.clone());
            }
            other => return Err(format!("unknown argument: {other}")),
        }
        at += 1;
    }
    let locator = match (vault, profile, file) {
        (Some(path), Some(profile), None) => Locator::Vault { path, profile },
        (None, None, Some(path)) => Locator::File { path },
        (None, None, None) => return Err("give --vault with --profile or --file".into()),
        (Some(_), None, _) => return Err("--vault needs --profile".into()),
        (None, Some(_), _) => return Err("--profile needs --vault".into()),
        _ => return Err("give either --vault with --profile or --file".into()),
    };
    Ok(Command { op, key, locator })
}

/// Runs `secrets …` with the arguments after `secrets`. Returns the exit code.
pub fn run(
    args: &[String],
    input: impl Read,
    mut output: impl Write,
    mut errors: impl Write,
) -> u8 {
    let keys = KeychainKeys {
        service: SERVICE.to_owned(),
    };
    run_with_keys(args, input, &mut output, &mut errors, &keys)
}

pub(crate) fn run_with_keys<K: KeySource>(
    args: &[String],
    input: impl Read,
    mut output: impl Write,
    mut errors: impl Write,
    keys: &K,
) -> u8 {
    let command = match parse(args) {
        Ok(command) => command,
        Err(message) => {
            let _ = writeln!(errors, "robot-host secrets: {message}");
            return EXIT_USAGE;
        }
    };
    let store: Box<dyn Store> = match command.locator {
        Locator::File { ref path } => Box::new(FileStore { path: path.clone() }),
        Locator::Vault {
            ref path,
            ref profile,
        } => match Vault::new(path.clone(), profile.clone(), keys) {
            Ok(vault) => Box::new(vault),
            Err(error) => {
                let _ = writeln!(errors, "robot-host secrets: {}", vault_reason(&error));
                return EXIT_USAGE;
            }
        },
    };
    run_with(store.as_ref(), &command, input, &mut output, &mut errors)
}

fn run_with(
    store: &dyn Store,
    command: &Command,
    mut input: impl Read,
    output: &mut impl Write,
    errors: &mut impl Write,
) -> u8 {
    let result = match command.op {
        Op::Get => match store.get(command.key.as_deref().unwrap_or_default()) {
            Ok(Some(value)) => output
                .write_all(value.as_bytes())
                .map(|_| EXIT_DONE)
                .map_err(|e| StoreError(e.to_string())),
            Ok(None) => Ok(EXIT_NONE),
            Err(e) => Err(e),
        },
        Op::Set => {
            let mut value = String::new();
            match input.read_to_string(&mut value) {
                Ok(_) => store
                    .set(command.key.as_deref().unwrap_or_default(), &value)
                    .map(|_| EXIT_DONE),
                Err(_) => Err(StoreError("the value is not text".into())),
            }
        }
        Op::Remove => store
            .remove(command.key.as_deref().unwrap_or_default())
            .map(|_| EXIT_DONE),
        Op::Check => store.check().map(|_| EXIT_DONE),
        Op::Destroy => store.destroy().map(|_| EXIT_DONE),
    };
    match result {
        Ok(code) => code,
        Err(error) => {
            // The reason only: never the key's value.
            let _ = writeln!(errors, "robot-host secrets: {error}");
            EXIT_FAILED
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vault::{BrokenKeys, EphemeralKeys, FailStoreKeys, RefusingKeys};

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    /// Runs a command against a file store and returns the exit code, stdout and stderr.
    fn run_file(file: &std::path::Path, list: &[&str], input: &str) -> (u8, String, String) {
        let mut all = args(list);
        all.push("--file".into());
        all.push(file.display().to_string());
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let code = run(&all, input.as_bytes(), &mut out, &mut err);
        (
            code,
            String::from_utf8(out).unwrap(),
            String::from_utf8(err).unwrap(),
        )
    }

    fn run_vault<K: KeySource>(
        vault: &std::path::Path,
        keys: &K,
        list: &[&str],
        input: &str,
    ) -> (u8, String, String) {
        let mut all = args(list);
        all.push("--vault".into());
        all.push(vault.display().to_string());
        all.push("--profile".into());
        all.push("default".into());
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let code = run_with_keys(&all, input.as_bytes(), &mut out, &mut err, keys);
        (
            code,
            String::from_utf8(out).unwrap(),
            String::from_utf8(err).unwrap(),
        )
    }

    fn vault_file(dir: &tempfile::TempDir) -> PathBuf {
        dir.path().join("secrets.vault")
    }

    #[test]
    fn a_vault_value_is_set_read_and_removed() {
        let dir = tempfile::tempdir().unwrap();
        let file = vault_file(&dir);
        let keys = EphemeralKeys::default();
        assert_eq!(run_vault(&file, &keys, &["get", "provider:a"], "").0, 3);
        assert_eq!(run_vault(&file, &keys, &["set", "provider:a"], "sk-1").0, 0);
        assert_eq!(
            run_vault(&file, &keys, &["get", "provider:a"], ""),
            (0, "sk-1".into(), "".into())
        );
        assert_eq!(run_vault(&file, &keys, &["remove", "provider:a"], "").0, 0);
        assert_eq!(run_vault(&file, &keys, &["get", "provider:a"], "").0, 3);
        assert_eq!(run_vault(&file, &keys, &["remove", "provider:a"], "").0, 0);
    }

    #[test]
    fn a_changed_byte_fails_without_the_value_on_either_stream() {
        let dir = tempfile::tempdir().unwrap();
        let file = vault_file(&dir);
        let keys = EphemeralKeys::default();
        assert_eq!(run_vault(&file, &keys, &["set", "k"], "secret-value").0, 0);
        let mut bytes = std::fs::read(&file).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0x01;
        std::fs::write(&file, &bytes).unwrap();
        let (code, out, err) = run_vault(&file, &keys, &["get", "k"], "");
        assert_eq!(code, 1);
        assert_eq!(out, "");
        assert_eq!(err, "robot-host secrets: secrets file is corrupt\n");
        assert!(!err.contains("secret-value"));
        assert_eq!(run_vault(&file, &keys, &["check"], "").0, 1);
        assert_eq!(run_vault(&file, &keys, &["remove", "k"], "").0, 1);
    }

    #[test]
    fn a_set_on_a_damaged_file_fails_and_keeps_the_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let file = vault_file(&dir);
        let keys = EphemeralKeys::default();
        assert_eq!(run_vault(&file, &keys, &["set", "k"], "v").0, 0);
        let mut bytes = std::fs::read(&file).unwrap();
        bytes[20] ^= 0x01;
        std::fs::write(&file, &bytes).unwrap();
        assert_eq!(run_vault(&file, &keys, &["set", "k"], "v2").0, 1);
        assert_eq!(std::fs::read(&file).unwrap(), bytes);
    }

    #[test]
    fn a_bad_header_is_corrupt() {
        let dir = tempfile::tempdir().unwrap();
        let file = vault_file(&dir);
        let keys = EphemeralKeys::default();
        assert_eq!(run_vault(&file, &keys, &["set", "k"], "v").0, 0);
        std::fs::write(&file, "not a vault").unwrap();
        assert_eq!(run_vault(&file, &keys, &["get", "k"], "").0, 1);
        assert_eq!(run_vault(&file, &keys, &["check"], "").0, 1);
    }

    #[test]
    fn a_file_without_its_key_reads_as_no_value() {
        let dir = tempfile::tempdir().unwrap();
        let file = vault_file(&dir);
        let keys = EphemeralKeys::default();
        assert_eq!(run_vault(&file, &keys, &["set", "k"], "v").0, 0);
        keys.remove("default").unwrap();
        assert_eq!(run_vault(&file, &keys, &["get", "k"], "").0, 3);
        assert_eq!(run_vault(&file, &keys, &["check"], "").0, 0);
    }

    #[test]
    fn the_first_set_after_a_lost_key_replaces_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = vault_file(&dir);
        let keys = EphemeralKeys::default();
        assert_eq!(run_vault(&file, &keys, &["set", "old"], "gone").0, 0);
        keys.remove("default").unwrap();
        assert_eq!(run_vault(&file, &keys, &["set", "new"], "here").0, 0);
        assert_eq!(
            run_vault(&file, &keys, &["get", "new"], ""),
            (0, "here".into(), "".into())
        );
        assert_eq!(run_vault(&file, &keys, &["get", "old"], "").0, 3);
    }

    #[test]
    fn a_first_set_that_cannot_store_its_key_leaves_no_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = vault_file(&dir);
        let keys = FailStoreKeys;
        let (code, out, err) = run_vault(&file, &keys, &["set", "k"], "v");
        assert_eq!(code, 1);
        assert_eq!(out, "");
        assert_eq!(err, "robot-host secrets: keychain error -1\n");
        assert!(!file.exists());
        assert_eq!(run_vault(&file, &keys, &["get", "k"], "").0, 3);
    }

    #[test]
    fn a_replace_that_cannot_store_its_key_leaves_missing_key() {
        let dir = tempfile::tempdir().unwrap();
        let file = vault_file(&dir);
        let keys = EphemeralKeys::default();
        assert_eq!(run_vault(&file, &keys, &["set", "old"], "v").0, 0);
        keys.remove("default").unwrap();
        assert_eq!(run_vault(&file, &FailStoreKeys, &["set", "k"], "v").0, 1);
        assert!(file.exists());
        assert_eq!(run_vault(&file, &keys, &["get", "old"], "").0, 3);
        assert_eq!(run_vault(&file, &keys, &["check"], "").0, 0);
    }

    #[test]
    fn a_set_whose_write_fails_stores_no_key_and_keeps_missing_key() {
        let dir = tempfile::tempdir().unwrap();
        let file = vault_file(&dir);
        let keys = EphemeralKeys::default();
        assert_eq!(run_vault(&file, &keys, &["set", "old"], "v").0, 0);
        keys.remove("default").unwrap();
        let before = std::fs::read(&file).unwrap();
        let mut tmp = file.as_os_str().to_owned();
        tmp.push(format!(".{}.tmp", std::process::id()));
        std::fs::create_dir(&tmp).unwrap();
        assert_eq!(run_vault(&file, &keys, &["set", "new"], "v2").0, 1);
        assert_eq!(keys.load("default").unwrap(), None);
        assert_eq!(std::fs::read(&file).unwrap(), before);
        assert_eq!(run_vault(&file, &keys, &["get", "old"], "").0, 3);
    }

    #[test]
    fn a_missing_file_needs_no_keychain() {
        let dir = tempfile::tempdir().unwrap();
        let file = vault_file(&dir);
        assert_eq!(run_vault(&file, &RefusingKeys, &["get", "k"], "").0, 3);
        assert_eq!(run_vault(&file, &RefusingKeys, &["remove", "k"], "").0, 0);
        let keys = EphemeralKeys::default();
        assert_eq!(run_vault(&file, &keys, &["check"], "").0, 0);
        assert_eq!(run_vault(&file, &keys, &["destroy"], "").0, 0);
    }

    #[test]
    fn check_is_never_3() {
        let dir = tempfile::tempdir().unwrap();
        let file = vault_file(&dir);
        let keys = EphemeralKeys::default();
        assert_ne!(run_vault(&file, &keys, &["check"], "").0, 3);
        assert_eq!(run_vault(&file, &keys, &["set", "k"], "v").0, 0);
        assert_ne!(run_vault(&file, &keys, &["check"], "").0, 3);
        keys.remove("default").unwrap();
        assert_ne!(run_vault(&file, &keys, &["check"], "").0, 3);
        std::fs::write(&file, "not a vault").unwrap();
        keys.store("default", &[1u8; 32]).unwrap();
        assert_ne!(run_vault(&file, &keys, &["check"], "").0, 3);
        assert_ne!(run_vault(&file, &BrokenKeys, &["check"], "").0, 3);
    }

    #[test]
    fn a_broken_keychain_is_exit_1_and_never_3() {
        let dir = tempfile::tempdir().unwrap();
        let file = vault_file(&dir);
        let keys = EphemeralKeys::default();
        assert_eq!(run_vault(&file, &keys, &["set", "k"], "v").0, 0);
        let (code, out, err) = run_vault(&file, &BrokenKeys, &["get", "k"], "");
        assert_eq!(code, 1);
        assert_eq!(out, "");
        assert_eq!(err, "robot-host secrets: keychain error -1\n");
        assert_eq!(run_vault(&file, &BrokenKeys, &["check"], "").0, 1);
        assert_eq!(run_vault(&file, &BrokenKeys, &["destroy"], "").0, 1);
    }

    #[test]
    fn destroy_twice_is_success_and_empties_the_vault() {
        let dir = tempfile::tempdir().unwrap();
        let file = vault_file(&dir);
        let keys = EphemeralKeys::default();
        assert_eq!(run_vault(&file, &keys, &["set", "k"], "v").0, 0);
        assert_eq!(run_vault(&file, &keys, &["destroy"], "").0, 0);
        assert!(!file.exists());
        assert_eq!(run_vault(&file, &keys, &["destroy"], "").0, 0);
        assert_eq!(run_vault(&file, &keys, &["get", "k"], "").0, 3);
        assert_eq!(run_vault(&file, &keys, &["check"], "").0, 0);
    }

    #[test]
    fn a_value_is_set_read_and_removed() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("secrets.json");
        assert_eq!(
            run_file(&file, &["get", "provider:a"], ""),
            (3, "".into(), "".into())
        );
        assert_eq!(run_file(&file, &["set", "provider:a"], "sk-1\nline").0, 0);
        assert_eq!(
            run_file(&file, &["get", "provider:a"], ""),
            (0, "sk-1\nline".into(), "".into())
        );
        assert_eq!(run_file(&file, &["remove", "provider:a"], "").0, 0);
        assert_eq!(run_file(&file, &["get", "provider:a"], "").0, 3);
        // A second removal is no error.
        assert_eq!(run_file(&file, &["remove", "provider:a"], "").0, 0);
    }

    #[test]
    fn the_file_is_one_json_object_as_the_tests_of_the_app_read_it() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("secrets.json");
        std::fs::write(&file, r#"{"decision:openrouter":"k"}"#).unwrap();
        assert_eq!(run_file(&file, &["set", "x"], "y").0, 0);
        let text = std::fs::read_to_string(&file).unwrap();
        assert_eq!(text, r#"{"decision:openrouter":"k","x":"y"}"#);
    }

    #[test]
    fn a_broken_file_fails_without_the_value_in_the_message() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("secrets.json");
        std::fs::write(&file, "not json").unwrap();
        let (code, out, err) = run_file(&file, &["set", "k"], "secret-value");
        assert_eq!(code, 1);
        assert_eq!(out, "");
        assert!(!err.contains("secret-value"));
    }

    #[test]
    fn the_file_store_checks_and_destroys() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("secrets.json");
        assert_eq!(run_file(&file, &["check"], "").0, 0);
        assert_eq!(run_file(&file, &["set", "k"], "v").0, 0);
        assert_eq!(run_file(&file, &["check"], "").0, 0);
        std::fs::write(&file, "not json").unwrap();
        assert_eq!(run_file(&file, &["check"], "").0, 1);
        assert_eq!(run_file(&file, &["destroy"], "").0, 0);
        assert!(!file.exists());
        assert_eq!(run_file(&file, &["destroy"], "").0, 0);
    }

    #[test]
    fn bad_arguments_exit_with_2() {
        for list in [
            &[][..],
            &["read", "k"][..],
            &["get"][..],
            &["get", ""][..],
            &["get", "k"][..],
            &["get", "k", "--file"][..],
            &["get", "k", "--vault"][..],
            &["get", "k", "--vault", "p"][..],
            &["get", "k", "--vault", "", "--profile", "x"][..],
            &["get", "k", "--profile", "x"][..],
            &["get", "k", "--profile", ""][..],
            &["get", "k", "--vault", "p", "--profile", "x", "--file", "f"][..],
            &["get", "k", "--other"][..],
            &["check", "k", "--file", "f"][..],
            &["destroy", "k", "--file", "f"][..],
            &["check"][..],
            &["destroy"][..],
        ] {
            let (mut out, mut err) = (Vec::new(), Vec::new());
            assert_eq!(
                run(&args(list), &b""[..], &mut out, &mut err),
                2,
                "{list:?}"
            );
        }
    }
}
