use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn secrets(vault: &Path, profile: &str, args: &[&str], input: &str) -> (i32, String, String) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_robot-host"))
        .arg("secrets")
        .args(args)
        .arg("--vault")
        .arg(vault)
        .arg("--profile")
        .arg(profile)
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

fn unique_profile() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("test-{}-{nanos}", std::process::id())
}

#[test]
#[ignore = "uses the keychain of the user"]
fn concurrent_writers_share_one_vault() {
    let profile = unique_profile();
    let dir = tempfile::tempdir().unwrap();
    let vault: PathBuf = dir.path().join("secrets.vault");

    std::thread::scope(|scope| {
        for task in 0..8 {
            let (profile, vault) = (profile.clone(), vault.clone());
            scope.spawn(move || {
                let key = format!("k{task}");
                let (code, _, err) = secrets(&vault, &profile, &["set", &key], "v");
                assert_eq!((code, err), (0, String::new()));
            });
        }
    });
    for task in 0..8 {
        let key = format!("k{task}");
        assert_eq!(
            secrets(&vault, &profile, &["get", &key], ""),
            (0, "v".into(), "".into())
        );
    }
    assert_eq!(secrets(&vault, &profile, &["check"], "").0, 0);
    assert_eq!(secrets(&vault, &profile, &["destroy"], "").0, 0);
    assert!(!vault.exists());
    assert_eq!(secrets(&vault, &profile, &["get", "k0"], "").0, 3);
    let found = Command::new("security")
        .args([
            "find-generic-password",
            "-s",
            "ROBot",
            "-a",
            &format!("vault:{profile}"),
        ])
        .output()
        .unwrap();
    assert!(!found.status.success());
}
