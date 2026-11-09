use std::collections::BTreeMap;
#[cfg(test)]
use std::collections::HashMap;
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::Mutex;

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};

/// The name under which the app keeps its secrets keys in the keychain.
pub const SERVICE: &str = "ROBot";

/// Magic and version at the start of the secrets file.
const MAGIC: &[u8; 4] = b"RBV1";
/// Nonce size of the cipher (ChaCha20-Poly1305).
const NONCE_LEN: usize = 12;
/// Secrets key size in bytes (256 bit).
const KEY_LEN: usize = 32;
/// Authentication tag size of the cipher.
const TAG_LEN: usize = 16;

/// Failure of the vault. No variant holds a value or key bytes, so stderr cannot leak them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VaultError {
    /// The keychain refused the run (locked, denied), or there is none. Holds the framework code or
    /// a fixed reason only.
    Keychain(String),
    /// Bad magic, version, JSON, or authentication failure.
    Corrupt(&'static str),
    /// File or lock failure. Holds the IO reason only.
    Io(String),
}

/// Source of the secrets key of one profile. The keychain answers in prod. Tests inject an
/// in-memory source, so no test touches the user keychain.
pub trait KeySource {
    /// Reads the key. `Ok(None)` means no key was stored yet.
    fn load(&self, profile: &str) -> Result<Option<[u8; 32]>, VaultError>;
    /// Stores the key. Overwrites. Idempotent.
    fn store(&self, profile: &str, key: &[u8; 32]) -> Result<(), VaultError>;
    /// Removes the key. A missing key is success.
    fn remove(&self, profile: &str) -> Result<(), VaultError>;
}

impl<K: KeySource> KeySource for &K {
    fn load(&self, profile: &str) -> Result<Option<[u8; 32]>, VaultError> {
        (**self).load(profile)
    }
    fn store(&self, profile: &str, key: &[u8; 32]) -> Result<(), VaultError> {
        (**self).store(profile, key)
    }
    fn remove(&self, profile: &str) -> Result<(), VaultError> {
        (**self).remove(profile)
    }
}

/// The keychain of the user: service [`SERVICE`], account `vault:<profile>`.
/// macOS only. Other systems fail with "no keychain on this system".
pub struct KeychainKeys {
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub service: String,
}

#[cfg(target_os = "macos")]
mod keychain {
    use super::{KeySource, KeychainKeys, VaultError};

    fn account(profile: &str) -> String {
        format!("vault:{profile}")
    }

    use security_framework::passwords::{
        delete_generic_password, get_generic_password, set_generic_password,
    };

    /// `errSecItemNotFound` of the Security framework. Only this code means "no key yet". Any
    /// other code (locked, denied) is a failure, never a missing value.
    const NOT_FOUND: i32 = -25300;

    fn failure(error: security_framework::base::Error) -> VaultError {
        VaultError::Keychain(error.code().to_string())
    }

    impl KeySource for KeychainKeys {
        fn load(&self, profile: &str) -> Result<Option<[u8; 32]>, VaultError> {
            match get_generic_password(&self.service, &account(profile)) {
                Ok(bytes) => bytes
                    .try_into()
                    .map(Some)
                    .map_err(|_| VaultError::Corrupt("the stored secrets key is not 32 bytes")),
                Err(e) if e.code() == NOT_FOUND => Ok(None),
                Err(e) => Err(failure(e)),
            }
        }

        fn store(&self, profile: &str, key: &[u8; 32]) -> Result<(), VaultError> {
            set_generic_password(&self.service, &account(profile), key).map_err(failure)
        }

        fn remove(&self, profile: &str) -> Result<(), VaultError> {
            match delete_generic_password(&self.service, &account(profile)) {
                Ok(()) => Ok(()),
                Err(e) if e.code() == NOT_FOUND => Ok(()),
                Err(e) => Err(failure(e)),
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
impl KeySource for KeychainKeys {
    fn load(&self, _profile: &str) -> Result<Option<[u8; 32]>, VaultError> {
        Err(VaultError::Keychain("no keychain on this system".into()))
    }
    fn store(&self, _profile: &str, _key: &[u8; 32]) -> Result<(), VaultError> {
        Err(VaultError::Keychain("no keychain on this system".into()))
    }
    fn remove(&self, _profile: &str) -> Result<(), VaultError> {
        Err(VaultError::Keychain("no keychain on this system".into()))
    }
}

#[cfg(test)]
#[derive(Debug, Default)]
pub struct EphemeralKeys {
    keys: Mutex<HashMap<String, [u8; 32]>>,
}

#[cfg(test)]
impl KeySource for EphemeralKeys {
    fn load(&self, profile: &str) -> Result<Option<[u8; 32]>, VaultError> {
        Ok(self.keys.lock().unwrap().get(profile).copied())
    }
    fn store(&self, profile: &str, key: &[u8; 32]) -> Result<(), VaultError> {
        self.keys.lock().unwrap().insert(profile.to_owned(), *key);
        Ok(())
    }
    fn remove(&self, profile: &str) -> Result<(), VaultError> {
        self.keys.lock().unwrap().remove(profile);
        Ok(())
    }
}

#[cfg(test)]
#[derive(Debug, Default)]
pub struct BrokenKeys;

#[cfg(test)]
impl KeySource for BrokenKeys {
    fn load(&self, _profile: &str) -> Result<Option<[u8; 32]>, VaultError> {
        Err(VaultError::Keychain("-1".into()))
    }
    fn store(&self, _profile: &str, _key: &[u8; 32]) -> Result<(), VaultError> {
        Err(VaultError::Keychain("-1".into()))
    }
    fn remove(&self, _profile: &str) -> Result<(), VaultError> {
        Err(VaultError::Keychain("-1".into()))
    }
}

#[cfg(test)]
#[derive(Debug, Default)]
pub struct RefusingKeys;

#[cfg(test)]
impl KeySource for RefusingKeys {
    fn load(&self, _profile: &str) -> Result<Option<[u8; 32]>, VaultError> {
        panic!("the keychain must not be read")
    }
    fn store(&self, _profile: &str, _key: &[u8; 32]) -> Result<(), VaultError> {
        panic!("the keychain must not be written")
    }
    fn remove(&self, _profile: &str) -> Result<(), VaultError> {
        Ok(())
    }
}

#[cfg(test)]
#[derive(Debug, Default)]
pub struct FailStoreKeys;

#[cfg(test)]
impl KeySource for FailStoreKeys {
    fn load(&self, _profile: &str) -> Result<Option<[u8; 32]>, VaultError> {
        Ok(None)
    }
    fn store(&self, _profile: &str, _key: &[u8; 32]) -> Result<(), VaultError> {
        Err(VaultError::Keychain("-1".into()))
    }
    fn remove(&self, _profile: &str) -> Result<(), VaultError> {
        Ok(())
    }
}

#[cfg(test)]
#[derive(Debug)]
pub struct FileKeys {
    pub path: PathBuf,
}

#[cfg(test)]
impl KeySource for FileKeys {
    fn load(&self, _profile: &str) -> Result<Option<[u8; 32]>, VaultError> {
        match std::fs::read(&self.path) {
            Ok(bytes) => bytes
                .try_into()
                .map(Some)
                .map_err(|_| VaultError::Corrupt("the stored secrets key is not 32 bytes")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(reason(e)),
        }
    }
    fn store(&self, _profile: &str, key: &[u8; 32]) -> Result<(), VaultError> {
        std::fs::write(&self.path, key).map_err(reason)
    }
    fn remove(&self, _profile: &str) -> Result<(), VaultError> {
        remove_missing(&self.path)
    }
}

fn reason(error: impl std::fmt::Display) -> VaultError {
    VaultError::Io(error.to_string())
}

pub struct Vault<K: KeySource> {
    path: PathBuf,
    profile: String,
    keys: K,
}

/// A `Made` key reaches the keychain only after its file lands, so a crash leaves Missing key.
enum KeyState {
    Loaded([u8; 32]),
    Made([u8; 32]),
}

impl KeyState {
    fn secret(&self) -> &[u8; 32] {
        match self {
            KeyState::Loaded(secret) | KeyState::Made(secret) => secret,
        }
    }
}

impl<K: KeySource> Vault<K> {
    /// Makes a vault handle. Does no IO. Fails only on an empty profile id.
    pub fn new(path: PathBuf, profile: String, keys: K) -> Result<Self, VaultError> {
        if profile.is_empty() {
            return Err(VaultError::Io("the profile id is empty".into()));
        }
        Ok(Self {
            path,
            profile,
            keys,
        })
    }

    pub fn get(&self, key: &str) -> Result<Option<String>, VaultError> {
        let _locked = self.lock()?;
        let Some(bytes) = read_file(&self.path)? else {
            return Ok(None);
        };
        let Some(secret) = self.keys.load(&self.profile)? else {
            return Ok(None);
        };
        Ok(open(&bytes, &secret)?.remove(key))
    }

    pub fn set(&self, key: &str, value: &str) -> Result<(), VaultError> {
        let _locked = self.lock()?;
        let state = match self.keys.load(&self.profile)? {
            Some(secret) => KeyState::Loaded(secret),
            None => {
                let mut secret = [0u8; KEY_LEN];
                getrandom::fill(&mut secret).map_err(reason)?;
                KeyState::Made(secret)
            }
        };
        let mut values = match (read_file(&self.path)?, &state) {
            (Some(bytes), KeyState::Loaded(secret)) => open(&bytes, secret)?,
            _ => BTreeMap::new(),
        };
        values.insert(key.to_owned(), value.to_owned());
        atomic_write(&self.path, &seal(&values, state.secret())?)?;
        if let KeyState::Made(secret) = &state {
            self.keys.store(&self.profile, secret)?;
        }
        Ok(())
    }

    pub fn remove(&self, key: &str) -> Result<(), VaultError> {
        let _locked = self.lock()?;
        let Some(bytes) = read_file(&self.path)? else {
            return Ok(());
        };
        let Some(secret) = self.keys.load(&self.profile)? else {
            return Ok(());
        };
        let mut values = open(&bytes, &secret)?;
        if values.remove(key).is_some() {
            atomic_write(&self.path, &seal(&values, &secret)?)?;
        }
        Ok(())
    }

    pub fn check(&self) -> Result<(), VaultError> {
        let _locked = self.lock()?;
        let secret = self.keys.load(&self.profile)?;
        match (read_file(&self.path)?, secret) {
            (Some(bytes), Some(secret)) => open(&bytes, &secret).map(|_| ()),
            _ => Ok(()),
        }
    }

    /// Deletes the secrets file (plus temp files) and the secrets key. Keeps the lock file, so a
    /// run that waits on it keeps waiting on the same file. Missing is success. Never touches old
    /// per-secret keychain entries.
    pub fn destroy(&self) -> Result<(), VaultError> {
        let _locked = self.lock()?;
        remove_missing(&self.path)?;
        self.sweep_temps();
        self.keys.remove(&self.profile)?;
        Ok(())
    }

    fn lock(&self) -> Result<File, VaultError> {
        let file = File::options()
            .create(true)
            .truncate(false)
            .write(true)
            .open(self.lock_path())
            .map_err(reason)?;
        use fs2::FileExt;
        file.lock_exclusive().map_err(reason)?;
        Ok(file)
    }

    fn lock_path(&self) -> PathBuf {
        let mut name = self.path.as_os_str().to_owned();
        name.push(".lock");
        PathBuf::from(name)
    }

    fn sweep_temps(&self) {
        let Some(dir) = self.path.parent() else {
            return;
        };
        let Some(stem) = self.path.file_name().map(|stem| {
            let mut prefix = stem.to_owned();
            prefix.push(".");
            prefix
        }) else {
            return;
        };
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            if name.as_encoded_bytes().starts_with(stem.as_encoded_bytes())
                && name.to_string_lossy().ends_with(".tmp")
            {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

fn read_file(path: &Path) -> Result<Option<Vec<u8>>, VaultError> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(reason(e)),
    }
}

fn remove_missing(path: &Path) -> Result<(), VaultError> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(reason(e)),
    }
}

fn seal(values: &BTreeMap<String, String>, key: &[u8; 32]) -> Result<Vec<u8>, VaultError> {
    let text = serde_json::to_vec(values).map_err(reason)?;
    let mut nonce = [0u8; NONCE_LEN];
    getrandom::fill(&mut nonce).map_err(reason)?;
    let body = ChaCha20Poly1305::new(Key::from_slice(key))
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &text,
                aad: MAGIC.as_slice(),
            },
        )
        .map_err(|_| VaultError::Io("cannot seal the secrets file".into()))?;
    let mut out = Vec::with_capacity(MAGIC.len() + NONCE_LEN + body.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&body);
    Ok(out)
}

fn open(bytes: &[u8], key: &[u8; 32]) -> Result<BTreeMap<String, String>, VaultError> {
    if bytes.len() < MAGIC.len() + NONCE_LEN + TAG_LEN {
        return Err(VaultError::Corrupt("the secrets file is too short"));
    }
    if &bytes[..MAGIC.len()] != MAGIC {
        return Err(VaultError::Corrupt("the secrets file has a bad magic"));
    }
    let plain = ChaCha20Poly1305::new(Key::from_slice(key))
        .decrypt(
            Nonce::from_slice(&bytes[MAGIC.len()..MAGIC.len() + NONCE_LEN]),
            Payload {
                msg: &bytes[MAGIC.len() + NONCE_LEN..],
                aad: MAGIC.as_slice(),
            },
        )
        .map_err(|_| VaultError::Corrupt("the secrets file fails authentication"))?;
    serde_json::from_slice(&plain)
        .map_err(|_| VaultError::Corrupt("the secrets file holds bad JSON"))
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), VaultError> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(format!(".{}.tmp", std::process::id()));
    let mut options = File::options();
    options.create(true).write(true).truncate(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(&tmp).map_err(reason)?;
    file.write_all(bytes).map_err(reason)?;
    file.sync_all().map_err(reason)?;
    drop(file);
    std::fs::rename(&tmp, path).map_err(reason)?;
    if let Some(dir) = path.parent()
        && let Ok(dir) = File::open(dir)
    {
        let _ = dir.sync_all();
    }
    Ok(())
}

#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt as _;

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt as _;

    fn vault<K: KeySource>(dir: &Path, keys: K) -> Vault<K> {
        Vault::new(dir.join("secrets.vault"), "default".into(), keys).unwrap()
    }

    #[test]
    fn a_value_is_set_read_and_removed() {
        let dir = tempfile::tempdir().unwrap();
        let keys = EphemeralKeys::default();
        let store = vault(dir.path(), &keys);
        assert_eq!(store.get("provider:a").unwrap(), None);
        store.set("provider:a", "sk-1\nline").unwrap();
        assert_eq!(store.get("provider:a").unwrap(), Some("sk-1\nline".into()));
        store.remove("provider:a").unwrap();
        assert_eq!(store.get("provider:a").unwrap(), None);
        store.remove("provider:a").unwrap();
    }

    #[test]
    fn reads_make_no_key_and_no_file() {
        let dir = tempfile::tempdir().unwrap();
        let keys = EphemeralKeys::default();
        let store = vault(dir.path(), &keys);
        assert_eq!(store.get("k").unwrap(), None);
        store.remove("k").unwrap();
        store.check().unwrap();
        assert_eq!(keys.load("default").unwrap(), None);
        assert!(!dir.path().join("secrets.vault").exists());
    }

    #[test]
    fn reads_of_a_missing_file_touch_no_keychain() {
        let dir = tempfile::tempdir().unwrap();
        let store = vault(dir.path(), RefusingKeys);
        assert_eq!(store.get("k").unwrap(), None);
        store.remove("k").unwrap();
    }

    #[test]
    fn a_file_without_its_key_reads_as_empty() {
        let dir = tempfile::tempdir().unwrap();
        let keys = EphemeralKeys::default();
        let store = vault(dir.path(), &keys);
        store.set("k", "v").unwrap();
        keys.remove("default").unwrap();
        assert_eq!(store.get("k").unwrap(), None);
        assert_eq!(store.get("other").unwrap(), None);
        store.check().unwrap();
        store.remove("k").unwrap();
    }

    #[test]
    fn the_first_set_after_a_lost_key_replaces_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let keys = EphemeralKeys::default();
        let store = vault(dir.path(), &keys);
        store.set("old", "gone").unwrap();
        keys.remove("default").unwrap();
        store.set("new", "here").unwrap();
        assert_eq!(store.get("new").unwrap(), Some("here".into()));
        assert_eq!(store.get("old").unwrap(), None);
    }

    #[test]
    fn remove_without_a_key_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let keys = EphemeralKeys::default();
        let store = vault(dir.path(), &keys);
        store.set("k", "v").unwrap();
        keys.remove("default").unwrap();
        let before = std::fs::read(dir.path().join("secrets.vault")).unwrap();
        store.remove("k").unwrap();
        assert_eq!(keys.load("default").unwrap(), None);
        assert_eq!(
            std::fs::read(dir.path().join("secrets.vault")).unwrap(),
            before
        );
    }

    #[test]
    fn a_changed_byte_breaks_the_whole_file() {
        let dir = tempfile::tempdir().unwrap();
        let keys = EphemeralKeys::default();
        let store = vault(dir.path(), &keys);
        store.set("a", "1").unwrap();
        store.set("b", "2").unwrap();
        let path = dir.path().join("secrets.vault");
        let mut bytes = std::fs::read(&path).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0x01;
        std::fs::write(&path, &bytes).unwrap();
        assert_eq!(
            store.get("a").unwrap_err(),
            VaultError::Corrupt("the secrets file fails authentication")
        );
        assert!(store.check().is_err());
    }

    #[test]
    fn a_bad_header_or_a_short_file_is_corrupt() {
        let dir = tempfile::tempdir().unwrap();
        let keys = EphemeralKeys::default();
        let store = vault(dir.path(), &keys);
        store.set("k", "v").unwrap();
        let path = dir.path().join("secrets.vault");
        for broken in [b"XXXX".to_vec(), b"RB".to_vec(), vec![0u8; 40]] {
            std::fs::write(&path, &broken).unwrap();
            assert!(matches!(store.get("k"), Err(VaultError::Corrupt(_))));
            assert!(matches!(store.check(), Err(VaultError::Corrupt(_))));
            assert!(matches!(store.remove("k"), Err(VaultError::Corrupt(_))));
        }
    }

    #[test]
    fn a_set_on_a_damaged_file_fails_and_keeps_the_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let keys = EphemeralKeys::default();
        let store = vault(dir.path(), &keys);
        store.set("k", "v").unwrap();
        let path = dir.path().join("secrets.vault");
        let mut bytes = std::fs::read(&path).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0x01;
        std::fs::write(&path, &bytes).unwrap();
        assert!(matches!(store.set("k", "v2"), Err(VaultError::Corrupt(_))));
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
    }

    #[test]
    fn a_broken_keychain_fails_when_a_file_needs_it() {
        let dir = tempfile::tempdir().unwrap();
        let keys = EphemeralKeys::default();
        vault(dir.path(), &keys).set("k", "v").unwrap();
        let store = vault(dir.path(), BrokenKeys);
        assert!(matches!(store.get("k"), Err(VaultError::Keychain(_))));
        assert!(matches!(store.set("k", "v"), Err(VaultError::Keychain(_))));
        assert!(matches!(store.remove("k"), Err(VaultError::Keychain(_))));
        assert!(matches!(store.check(), Err(VaultError::Keychain(_))));
    }

    #[test]
    fn a_broken_keychain_still_reads_a_missing_file_as_no_value() {
        let dir = tempfile::tempdir().unwrap();
        let store = vault(dir.path(), BrokenKeys);
        assert_eq!(store.get("k").unwrap(), None);
        store.remove("k").unwrap();
        assert!(matches!(store.check(), Err(VaultError::Keychain(_))));
    }

    #[test]
    fn writers_from_many_threads_lose_no_key() {
        let dir = tempfile::tempdir().unwrap();
        let keys = EphemeralKeys::default();
        let store = vault(dir.path(), &keys);
        let shared = &store;
        std::thread::scope(|scope| {
            for task in 0..8 {
                scope.spawn(move || {
                    for each in 0..25 {
                        shared.set(&format!("t{task}k{each}"), "v").unwrap();
                    }
                });
            }
        });
        for task in 0..8 {
            for each in 0..25 {
                assert_eq!(
                    store.get(&format!("t{task}k{each}")).unwrap(),
                    Some("v".into())
                );
            }
        }
    }

    #[test]
    fn remove_of_a_missing_key_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let keys = EphemeralKeys::default();
        let store = vault(dir.path(), &keys);
        store.set("k", "v").unwrap();
        let before = std::fs::read(dir.path().join("secrets.vault")).unwrap();
        store.remove("other").unwrap();
        assert_eq!(
            std::fs::read(dir.path().join("secrets.vault")).unwrap(),
            before
        );
    }

    #[test]
    fn destroy_removes_the_file_and_the_key_but_keeps_the_lock() {
        let dir = tempfile::tempdir().unwrap();
        let keys = EphemeralKeys::default();
        let store = vault(dir.path(), &keys);
        store.set("k", "v").unwrap();
        store.destroy().unwrap();
        assert!(!dir.path().join("secrets.vault").exists());
        assert!(dir.path().join("secrets.vault.lock").exists());
        assert_eq!(keys.load("default").unwrap(), None);
        assert_eq!(store.get("k").unwrap(), None);
        store.destroy().unwrap();
        store.check().unwrap();
    }

    #[test]
    fn destroy_of_a_missing_vault_is_success() {
        let dir = tempfile::tempdir().unwrap();
        let keys = EphemeralKeys::default();
        vault(dir.path(), &keys).destroy().unwrap();
    }

    #[test]
    fn an_empty_profile_id_fails() {
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(
            Vault::new(dir.path().join("s"), "".into(), EphemeralKeys::default()),
            Err(VaultError::Io(_))
        ));
    }

    #[test]
    fn the_file_shows_no_whole_map_and_no_value() {
        let dir = tempfile::tempdir().unwrap();
        let keys = EphemeralKeys::default();
        let store = vault(dir.path(), &keys);
        store.set("provider:a", "sk-secret").unwrap();
        let bytes = std::fs::read(dir.path().join("secrets.vault")).unwrap();
        assert_eq!(&bytes[..4], b"RBV1");
        assert!(!bytes.windows(9).any(|window| window == b"sk-secret"));
        assert!(!bytes.windows(10).any(|window| window == b"provider:a"));
    }

    #[test]
    #[cfg(unix)]
    fn the_file_is_readable_by_the_user_only() {
        let dir = tempfile::tempdir().unwrap();
        let keys = EphemeralKeys::default();
        vault(dir.path(), &keys).set("k", "v").unwrap();
        let mode = std::fs::metadata(dir.path().join("secrets.vault"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o077, 0);
    }

    #[test]
    fn two_seals_of_one_map_share_no_nonce_and_no_ciphertext() {
        let mut values = BTreeMap::new();
        values.insert("k".to_owned(), "v".to_owned());
        let key = [3u8; KEY_LEN];
        let first = seal(&values, &key).unwrap();
        let second = seal(&values, &key).unwrap();
        assert_ne!(
            &first[MAGIC.len()..MAGIC.len() + NONCE_LEN],
            &second[MAGIC.len()..MAGIC.len() + NONCE_LEN]
        );
        assert_ne!(
            &first[MAGIC.len() + NONCE_LEN..],
            &second[MAGIC.len() + NONCE_LEN..]
        );
    }

    #[test]
    fn a_changed_header_byte_and_a_wrong_aad_are_corrupt() {
        let dir = tempfile::tempdir().unwrap();
        let keys = EphemeralKeys::default();
        let store = vault(dir.path(), &keys);
        store.set("k", "v").unwrap();
        let path = dir.path().join("secrets.vault");
        let mut bytes = std::fs::read(&path).unwrap();
        bytes[0] ^= 0x01;
        std::fs::write(&path, &bytes).unwrap();
        assert!(matches!(store.get("k"), Err(VaultError::Corrupt(_))));
        let secret = keys.load("default").unwrap().unwrap();
        let body = ChaCha20Poly1305::new(Key::from_slice(&secret))
            .encrypt(
                Nonce::from_slice(&[0u8; NONCE_LEN]),
                Payload {
                    msg: &b"{}"[..],
                    aad: b"XXXX",
                },
            )
            .unwrap();
        let mut plain = Vec::new();
        plain.extend_from_slice(MAGIC);
        plain.extend_from_slice(&[0u8; NONCE_LEN]);
        plain.extend_from_slice(&body);
        std::fs::write(&path, &plain).unwrap();
        assert!(matches!(store.get("k"), Err(VaultError::Corrupt(_))));
        assert!(matches!(store.check(), Err(VaultError::Corrupt(_))));
    }

    #[test]
    fn vault_child_writes_one_key() {
        let (Some(vault), Some(keyfile), Some(key)) = (
            std::env::var("ROBOT_VAULT_CHILD_VAULT").ok(),
            std::env::var("ROBOT_VAULT_CHILD_KEYFILE").ok(),
            std::env::var("ROBOT_VAULT_CHILD_KEY").ok(),
        ) else {
            return;
        };
        Vault::new(
            PathBuf::from(vault),
            "default".into(),
            FileKeys {
                path: PathBuf::from(keyfile),
            },
        )
        .unwrap()
        .set(&key, "v")
        .unwrap();
    }

    #[test]
    fn writers_from_many_processes_lose_no_key() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path().join("secrets.vault");
        let keyfile = dir.path().join("test.key");
        let mut key = [0u8; KEY_LEN];
        getrandom::fill(&mut key).unwrap();
        std::fs::write(&keyfile, key).unwrap();
        let mut children = Vec::new();
        for task in 0..8 {
            children.push(
                std::process::Command::new(std::env::current_exe().unwrap())
                    .args(["--exact", "vault::tests::vault_child_writes_one_key"])
                    .env("ROBOT_VAULT_CHILD_VAULT", &vault)
                    .env("ROBOT_VAULT_CHILD_KEYFILE", &keyfile)
                    .env("ROBOT_VAULT_CHILD_KEY", format!("p{task}"))
                    .spawn()
                    .unwrap(),
            );
        }
        for child in &mut children {
            assert!(child.wait().unwrap().success());
        }
        let store = Vault::new(vault, "default".into(), FileKeys { path: keyfile }).unwrap();
        for task in 0..8 {
            assert_eq!(store.get(&format!("p{task}")).unwrap(), Some("v".into()));
        }
    }

    #[test]
    #[ignore = "uses the keychain of the user"]
    fn the_keychain_keeps_a_secrets_key() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let profile = format!("test-{}-{nanos}", std::process::id());
        let keys = KeychainKeys {
            service: SERVICE.to_owned(),
        };
        assert_eq!(keys.load(&profile).unwrap(), None);
        let dir = tempfile::tempdir().unwrap();
        let store = Vault::new(
            dir.path().join("secrets.vault"),
            profile.clone(),
            KeychainKeys {
                service: SERVICE.to_owned(),
            },
        )
        .unwrap();
        store.set("k", "v").unwrap();
        store.set("k", "v2").unwrap();
        assert_eq!(store.get("k").unwrap(), Some("v2".into()));
        store.destroy().unwrap();
        assert_eq!(keys.load(&profile).unwrap(), None);
        assert!(!dir.path().join("secrets.vault").exists());
    }
}
