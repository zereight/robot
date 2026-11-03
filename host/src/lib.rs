//! The host of ROBot. The desktop app starts it as a child process and sends it the requests of
//! the window and of linked devices (see `protocol`). Its work moves here from the main process of
//! the app one method at a time.

pub mod licenses;
pub mod methods;
pub mod protocol;
pub mod secrets;

use std::io::{self, BufRead, Write};
use std::path::PathBuf;

use protocol::{Response, parse_line};

/// What every request can read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Context {
    /// The data folder of the app.
    pub data_dir: PathBuf,
}

/// Reads the arguments after the program name: `--data <folder>`.
pub fn parse_args(args: impl IntoIterator<Item = String>) -> Result<Context, String> {
    let mut args = args.into_iter();
    let mut data_dir = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--data" => data_dir = Some(args.next().ok_or("--data needs a folder")?),
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    let data_dir = data_dir.ok_or("give the data folder: --data <folder>")?;
    Ok(Context {
        data_dir: PathBuf::from(data_dir),
    })
}

/// Answers requests until the input ends. The input ends when the app closes the pipe or stops,
/// so the host never outlives the app.
pub fn serve(input: impl BufRead, mut output: impl Write, context: &Context) -> io::Result<()> {
    for line in input.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let response = match parse_line(&line) {
            Ok(request) => Response {
                id: request.id,
                result: methods::handle(context, &request),
            },
            Err(Some(response)) => response,
            Err(None) => {
                eprintln!("host: skipped a line that is not a request");
                continue;
            }
        };
        serde_json::to_writer(&mut output, &response)?;
        output.write_all(b"\n")?;
        output.flush()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn the_data_folder_is_read() {
        let context = parse_args(args(&["--data", "/tmp/x"])).unwrap();
        assert_eq!(context.data_dir, PathBuf::from("/tmp/x"));
    }

    #[test]
    fn a_missing_or_unknown_argument_fails() {
        assert!(parse_args(args(&[])).is_err());
        assert!(parse_args(args(&["--data"])).is_err());
        assert!(parse_args(args(&["--data", "/tmp/x", "--other"])).is_err());
    }

    #[test]
    fn each_request_gets_one_line_with_its_id() {
        let context = parse_args(args(&["--data", "/tmp/x"])).unwrap();
        let input = b"{\"id\":1,\"method\":\"app.licenses\"}\n\n{\"id\":2,\"method\":\"no.such\"}\nnot json\n";
        let mut output = Vec::new();
        serve(&input[..], &mut output, &context).unwrap();
        let lines: Vec<serde_json::Value> = String::from_utf8(output)
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["id"], 1);
        assert_eq!(lines[0]["result"]["ok"], true);
        assert_eq!(lines[1]["id"], 2);
        assert_eq!(lines[1]["result"]["error"]["code"], "unknown_method");
    }
}
