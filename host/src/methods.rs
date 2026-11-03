//! The requests that the host answers. Each method has the name and the result shape of the
//! window call of the same name (`packages/shared/src/ipc.ts`). The desktop app sends only the
//! methods in its list of host methods to the host.

use crate::Context;
use crate::licenses;
use crate::protocol::{Outcome, Request};

pub fn handle(_context: &Context, request: &Request) -> Outcome {
    match request.method.as_str() {
        "app.licenses" => Outcome::value(licenses::all()),
        method => Outcome::failure("unknown_method", method),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::parse_line;
    use std::path::PathBuf;

    fn context() -> Context {
        Context {
            data_dir: PathBuf::from("/tmp/robot-test"),
        }
    }

    #[test]
    fn licenses_answer_with_a_list() {
        let request = parse_line(r#"{"id":1,"method":"app.licenses"}"#).unwrap();
        let outcome = handle(&context(), &request);
        assert!(outcome.ok);
        assert!(
            outcome
                .value
                .unwrap()
                .as_array()
                .is_some_and(|l| !l.is_empty())
        );
    }

    #[test]
    fn an_unknown_method_fails_with_its_name() {
        let request = parse_line(r#"{"id":1,"method":"nothing.here"}"#).unwrap();
        let outcome = handle(&context(), &request);
        let error = outcome.error.unwrap();
        assert_eq!(error.code, "unknown_method");
        assert_eq!(error.message, "nothing.here");
    }
}
