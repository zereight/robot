//! Keys and tokens of the app. They live in the system keychain and nowhere else; end-to-end
//! tests on machines without a usable keychain use one file outside the data folder.
//!
//! The main process calls this part as a short command, and waits for it:
//!
//! ```text
//! robot-host secrets get <key> [--file <path>]      the value on stdout; exit 3 when there is none
//! robot-host secrets set <key> [--file <path>]      the value on stdin
//! robot-host secrets remove <key> [--file <path>]   no error when there is no value
//! ```
//!
//! Exit codes: 0 done, 1 the store failed (the reason on stderr), 2 bad arguments, 3 no value.

use std::collections::BTreeMap;
use std::fmt;
use std::io::{Read, Write};
use std::path::PathBuf;

/// The name under which the app keeps its values in the keychain.
pub const SERVICE: &str = "ROBot";

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
}

/// The keychain of the user: one generic password per key, with the service [`SERVICE`] and the
/// key as the account.
pub struct Keychain {
    pub service: String,
}

#[cfg(target_os = "macos")]
mod keychain {
    use super::{Keychain, Store, StoreError};
    use security_framework::passwords::{
        delete_generic_password, get_generic_password, set_generic_password,
    };

    /// `errSecItemNotFound` of the Security framework.
    const NOT_FOUND: i32 = -25300;

    fn failure(error: security_framework::base::Error) -> StoreError {
        StoreError(format!("keychain error {}", error.code()))
    }

    impl Store for Keychain {
        fn get(&self, key: &str) -> Result<Option<String>, StoreError> {
            match get_generic_password(&self.service, key) {
                Ok(bytes) => String::from_utf8(bytes)
                    .map(Some)
                    .map_err(|_| StoreError("the keychain value is not text".into())),
                Err(e) if e.code() == NOT_FOUND => Ok(None),
                Err(e) => Err(failure(e)),
            }
        }

        fn set(&self, key: &str, value: &str) -> Result<(), StoreError> {
            set_generic_password(&self.service, key, value.as_bytes()).map_err(failure)
        }

        fn remove(&self, key: &str) -> Result<(), StoreError> {
            match delete_generic_password(&self.service, key) {
                Ok(()) => Ok(()),
                Err(e) if e.code() == NOT_FOUND => Ok(()),
                Err(e) => Err(failure(e)),
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
impl Store for Keychain {
    fn get(&self, _key: &str) -> Result<Option<String>, StoreError> {
        Err(StoreError("no keychain on this system".into()))
    }
    fn set(&self, _key: &str, _value: &str) -> Result<(), StoreError> {
        Err(StoreError("no keychain on this system".into()))
    }
    fn remove(&self, _key: &str) -> Result<(), StoreError> {
        Err(StoreError("no keychain on this system".into()))
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
}

struct Command {
    op: Op,
    key: String,
    file: Option<PathBuf>,
}

fn parse(args: &[String]) -> Result<Command, String> {
    let mut args = args.iter();
    let op = match args.next().map(String::as_str) {
        Some("get") => Op::Get,
        Some("set") => Op::Set,
        Some("remove") => Op::Remove,
        _ => return Err("give get, set or remove".into()),
    };
    let key = args.next().filter(|k| !k.is_empty()).ok_or("give a key")?;
    let mut file = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--file" => file = Some(PathBuf::from(args.next().ok_or("--file needs a path")?)),
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    Ok(Command {
        op,
        key: key.clone(),
        file,
    })
}

/// Runs `secrets …` with the arguments after `secrets`. Returns the exit code.
pub fn run(
    args: &[String],
    input: impl Read,
    mut output: impl Write,
    mut errors: impl Write,
) -> u8 {
    let command = match parse(args) {
        Ok(command) => command,
        Err(message) => {
            let _ = writeln!(errors, "robot-host secrets: {message}");
            return EXIT_USAGE;
        }
    };
    let store: Box<dyn Store> = match command.file {
        Some(ref path) => Box::new(FileStore { path: path.clone() }),
        None => Box::new(Keychain {
            service: SERVICE.into(),
        }),
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
        Op::Get => match store.get(&command.key) {
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
                Ok(_) => store.set(&command.key, &value).map(|_| EXIT_DONE),
                Err(_) => Err(StoreError("the value is not text".into())),
            }
        }
        Op::Remove => store.remove(&command.key).map(|_| EXIT_DONE),
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
    fn bad_arguments_exit_with_2() {
        for list in [
            &[][..],
            &["read", "k"][..],
            &["get"][..],
            &["get", ""][..],
            &["get", "k", "--file"][..],
            &["get", "k", "--other"][..],
        ] {
            let (mut out, mut err) = (Vec::new(), Vec::new());
            assert_eq!(
                run(&args(list), &b""[..], &mut out, &mut err),
                2,
                "{list:?}"
            );
        }
    }

    /// Writes, reads and removes a value in the real keychain, under a service of its own. Run it
    /// by hand on a Mac: `cargo test --manifest-path host/Cargo.toml -- --ignored`.
    #[test]
    #[ignore = "uses the keychain of the user"]
    fn the_keychain_keeps_a_value() {
        let store = Keychain {
            service: format!("ROBot test {}", std::process::id()),
        };
        assert_eq!(store.get("k").unwrap(), None);
        store.set("k", "v1").unwrap();
        store.set("k", "v2").unwrap();
        assert_eq!(store.get("k").unwrap(), Some("v2".into()));
        store.remove("k").unwrap();
        store.remove("k").unwrap();
        assert_eq!(store.get("k").unwrap(), None);
    }
}
