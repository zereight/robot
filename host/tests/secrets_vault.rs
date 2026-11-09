//! Runs the built program against the real keychain, under a service of its own. Run it by
//! hand on a Mac: `cargo test --manifest-path host/Cargo.toml -- --ignored`. It writes one
//! secrets key and one secrets file, then removes both.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Runs `robot-host secrets …` with the test service and returns the exit code, stdout, stderr.
fn secrets(service: &str, vault: &Path, args: &[&str], input: &str) -> (i32, String, String) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_robot-host"))
        .arg("secrets")
        .args(args)
        .arg("--vault")
        .arg(vault)
        .arg("--profile")
        .arg("default")
        .env("ROBOT_TEST_KEYCHAIN_SERVICE", service)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    (
        out.status.code().unwrap(),
        String::from_utf8(out.stdout).unwrap(),
        String::from_utf8(out.stderr).unwrap(),
    )
}

/// Writers from many processes lose no key, and `destroy` removes the file and the key.
#[test]
#[ignore = "uses the keychain of the user"]
fn concurrent_writers_share_one_vault() {
    let service = format!("ROBot test vault {}", std::process::id());
    let dir = tempfile::tempdir().unwrap();
    let vault: PathBuf = dir.path().join("secrets.vault");

    std::thread::scope(|scope| {
        for task in 0..8 {
            let (service, vault) = (service.clone(), vault.clone());
            scope.spawn(move || {
                let key = format!("k{task}");
                let (code, _, err) = secrets(&service, &vault, &["set", &key], "v");
                assert_eq!((code, err), (0, String::new()));
            });
        }
    });
    for task in 0..8 {
        let key = format!("k{task}");
        assert_eq!(
            secrets(&service, &vault, &["get", &key], ""),
            (0, "v".into(), "".into())
        );
    }
    assert_eq!(secrets(&service, &vault, &["check"], "").0, 0);
    assert_eq!(secrets(&service, &vault, &["destroy"], "").0, 0);
    assert!(!vault.exists());
    assert_eq!(secrets(&service, &vault, &["get", "k0"], "").0, 3);
    // The secrets key is gone from the keychain too.
    let found = Command::new("security")
        .args([
            "find-generic-password",
            "-s",
            &service,
            "-a",
            "vault:default",
        ])
        .output()
        .unwrap();
    assert!(!found.status.success());
}
