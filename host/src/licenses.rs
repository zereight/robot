//! The open-source licenses of the parts that the app ships (Settings → About).

use serde::{Deserialize, Serialize};

/// The packages of the desktop app, written by `bun run licenses` in `apps/desktop`.
const DESKTOP: &str = include_str!("../../apps/desktop/src/main/licenses.json");
/// The crates of the host, written by the licenses test of the host (see `tests/licenses.rs`).
const HOST: &str = include_str!("../licenses.json");

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct License {
    pub name: String,
    pub version: String,
    pub license: String,
}

fn read(list: &str) -> Vec<License> {
    // Both lists are checked by tests before a build, so a bad list is a defect of the build.
    serde_json::from_str(list).expect("the license lists in the build are valid")
}

/// Every package and crate of the app, sorted by name, each name and version once.
pub fn all() -> Vec<License> {
    let mut list = read(DESKTOP);
    list.extend(read(HOST));
    list.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.version.cmp(&b.version))
    });
    list.dedup_by(|a, b| a.name == b.name && a.version == b.version);
    list
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_list_has_packages_of_the_app_and_crates_of_the_host() {
        let list = all();
        assert!(list.iter().any(|l| l.name == "solid-js"));
        assert!(list.iter().any(|l| l.name == "serde_json"));
    }

    #[test]
    fn the_list_is_sorted_and_has_no_twins() {
        let list = all();
        for pair in list.windows(2) {
            let (a, b) = (&pair[0], &pair[1]);
            assert!(a.name.to_lowercase() <= b.name.to_lowercase());
            assert!(!(a.name == b.name && a.version == b.version));
        }
    }
}
