//! Runs the built program the way the desktop app does: requests on standard input, one answer
//! per line on standard output, and an end when the input closes.

use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

use serde_json::Value;

#[test]
fn the_program_answers_and_ends_when_its_input_closes() {
    let data = std::env::temp_dir().join("robot-host-stdio-test");
    let mut child = Command::new(env!("CARGO_BIN_EXE_robot-host"))
        .arg("--data")
        .arg(&data)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());

    writeln!(stdin, r#"{{"id":41,"method":"app.licenses","input":null}}"#).unwrap();
    let mut line = String::new();
    stdout.read_line(&mut line).unwrap();
    let answer: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(answer["id"], 41);
    assert_eq!(answer["result"]["ok"], true);
    let names: Vec<&str> = answer["result"]["value"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"serde_json"));

    drop(stdin);
    let status = child.wait().unwrap();
    assert!(status.success());
}

#[test]
fn the_program_refuses_to_start_without_a_data_folder() {
    let output = Command::new(env!("CARGO_BIN_EXE_robot-host"))
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("--data"));
}
