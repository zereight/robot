use std::io;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // A short command of the main process: one keychain read or write, then the end.
    if args.first().map(String::as_str) == Some("secrets") {
        let code = robot_host::secrets::run(&args[1..], io::stdin(), io::stdout(), io::stderr());
        return ExitCode::from(code);
    }
    let context = match robot_host::parse_args(args) {
        Ok(context) => context,
        Err(message) => {
            eprintln!("robot-host: {message}");
            return ExitCode::from(2);
        }
    };
    match robot_host::serve(io::stdin().lock(), io::stdout().lock(), &context) {
        Ok(()) => ExitCode::SUCCESS,
        // The app closed its end of the pipe: there is no one left to answer.
        Err(error) if error.kind() == io::ErrorKind::BrokenPipe => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("robot-host: {error}");
            ExitCode::FAILURE
        }
    }
}
