//! The license list of the host crates (`host/licenses.json`) must match `Cargo.lock`, and every
//! crate must have a license that the app may ship (AGENTS.md).
//!
//! After a change of the dependencies, write the list again:
//!   ROBOT_UPDATE_LICENSES=1 cargo test --manifest-path host/Cargo.toml --test licenses

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::process::Command;

use serde::Serialize;
use serde_json::Value;

/// One line of the list, with the fields in the order of the list of the desktop app.
#[derive(Serialize)]
struct Entry {
    name: String,
    version: String,
    license: String,
}

/// Licenses that the app may ship. "MIT-compatible" in AGENTS.md, plus Unicode-3.0, the license
/// of the Unicode data tables that the parsers of Rust use; it asks for the same notice as MIT.
const ALLOWED: &[&str] = &[
    "MIT",
    "MIT-0",
    "Apache-2.0",
    "Apache-2.0 WITH LLVM-exception",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "ISC",
    "0BSD",
    "Zlib",
    "Unicode-3.0",
];

/// The crates that the host program is built from: the dependencies of `robot-host`, without the
/// crates that only its tests use.
fn shipped_crates() -> Vec<Entry> {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
    let output = Command::new(cargo)
        .args([
            "metadata",
            "--format-version",
            "1",
            "--locked",
            "--manifest-path",
        ])
        .arg(&manifest)
        .output()
        .expect("cargo metadata runs");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let metadata: Value = serde_json::from_slice(&output.stdout).unwrap();

    let packages: BTreeMap<&str, &Value> = metadata["packages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| (p["id"].as_str().unwrap(), p))
        .collect();
    let nodes: BTreeMap<&str, &Value> = metadata["resolve"]["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| (n["id"].as_str().unwrap(), n))
        .collect();
    let root = metadata["resolve"]["root"].as_str().unwrap();

    let mut seen = BTreeSet::new();
    let mut queue = vec![root];
    while let Some(id) = queue.pop() {
        for dep in nodes[id]["deps"].as_array().unwrap() {
            let not_only_dev = dep["dep_kinds"]
                .as_array()
                .unwrap()
                .iter()
                .any(|k| k["kind"].as_str() != Some("dev"));
            let pkg = dep["pkg"].as_str().unwrap();
            if not_only_dev && seen.insert(pkg) {
                queue.push(pkg);
            }
        }
    }

    let text = |value: &Value| value.as_str().unwrap_or("UNKNOWN").to_owned();
    let mut list: Vec<Entry> = seen
        .into_iter()
        .map(|id| {
            let p = packages[id];
            Entry {
                name: text(&p["name"]),
                version: text(&p["version"]),
                license: text(&p["license"]),
            }
        })
        .collect();
    list.sort_by_key(|p| (p.name.to_lowercase(), p.version.clone()));
    list
}

/// Reads an SPDX expression: `A OR B` needs one allowed side, `A AND B` needs both.
fn allowed(expression: &str) -> bool {
    let normal = expression.replace('/', " OR ");
    let tokens: Vec<String> = normal
        .replace('(', " ( ")
        .replace(')', " ) ")
        .split_whitespace()
        .map(str::to_owned)
        .collect();
    let mut at = 0;
    let result = or(&tokens, &mut at);
    result && at == tokens.len()
}

fn or(tokens: &[String], at: &mut usize) -> bool {
    let mut result = and(tokens, at);
    while tokens.get(*at).is_some_and(|t| t == "OR") {
        *at += 1;
        result |= and(tokens, at);
    }
    result
}

fn and(tokens: &[String], at: &mut usize) -> bool {
    let mut result = one(tokens, at);
    while tokens.get(*at).is_some_and(|t| t == "AND") {
        *at += 1;
        result &= one(tokens, at);
    }
    result
}

fn one(tokens: &[String], at: &mut usize) -> bool {
    let Some(token) = tokens.get(*at) else {
        return false;
    };
    *at += 1;
    if token == "(" {
        let result = or(tokens, at);
        *at += 1; // ")"
        return result;
    }
    let mut name = token.clone();
    if tokens.get(*at).is_some_and(|t| t == "WITH") {
        name = format!(
            "{name} WITH {}",
            tokens.get(*at + 1).cloned().unwrap_or_default()
        );
        *at += 2;
    }
    ALLOWED.contains(&name.as_str())
}

#[test]
fn the_license_list_matches_the_lock_file() {
    let list = shipped_crates();
    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("licenses.json");
    let written = format!("{}\n", serde_json::to_string_pretty(&list).unwrap());
    if std::env::var_os("ROBOT_UPDATE_LICENSES").is_some() {
        std::fs::write(&file, &written).unwrap();
        return;
    }
    let current = std::fs::read_to_string(&file).unwrap();
    assert_eq!(
        current, written,
        "host/licenses.json is old. Run: ROBOT_UPDATE_LICENSES=1 cargo test --manifest-path host/Cargo.toml --test licenses"
    );
}

#[test]
fn every_crate_has_an_allowed_license() {
    let refused: Vec<String> = shipped_crates()
        .iter()
        .filter(|p| !allowed(&p.license))
        .map(|p| format!("{} {}: {}", p.name, p.version, p.license))
        .collect();
    assert!(
        refused.is_empty(),
        "licenses that the app may not ship: {refused:?}"
    );
}

#[test]
fn license_expressions_read_as_spdx() {
    assert!(allowed("MIT"));
    assert!(allowed("MIT OR Apache-2.0"));
    assert!(allowed("MIT/Apache-2.0"));
    assert!(allowed("(MIT OR Apache-2.0) AND Unicode-3.0"));
    assert!(allowed("Apache-2.0 WITH LLVM-exception OR MIT"));
    assert!(allowed("GPL-3.0 OR MIT"));
    assert!(!allowed("GPL-3.0"));
    assert!(!allowed("MIT AND GPL-3.0"));
    assert!(!allowed("UNKNOWN"));
    assert!(!allowed(""));
}
