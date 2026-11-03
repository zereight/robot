use std::io;
use std::process::ExitCode;

fn main() -> ExitCode {
    let context = match robot_host::parse_args(std::env::args().skip(1)) {
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
