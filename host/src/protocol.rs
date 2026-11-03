//! The messages between the desktop app and the host.
//!
//! The app starts the host and writes one request per line to its standard input. The host writes
//! one response per line to its standard output, with the id of the request. Responses can come
//! in another order than the requests. Standard error is for logs only.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A linked device that makes the request (spec 012). `None` is the window of this computer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Actor {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Deserialize)]
pub struct Request {
    pub id: u64,
    pub method: String,
    #[serde(default)]
    pub input: Value,
    #[serde(default)]
    pub actor: Option<Actor>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Failure {
    pub code: String,
    pub message: String,
}

/// The outcome of one request, in the same shape as the results of the window calls:
/// `{ "ok": true, "value": … }` or `{ "ok": false, "error": { "code", "message" } }`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Outcome {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<Failure>,
}

impl Outcome {
    pub fn value(value: impl Serialize) -> Self {
        match serde_json::to_value(value) {
            Ok(value) => Self {
                ok: true,
                value: Some(value),
                error: None,
            },
            Err(_) => Self::failure("internal", "Unexpected error"),
        }
    }

    pub fn failure(code: &str, message: &str) -> Self {
        Self {
            ok: false,
            value: None,
            error: Some(Failure {
                code: code.to_owned(),
                message: message.to_owned(),
            }),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct Response {
    pub id: u64,
    pub result: Outcome,
}

/// Reads one line of input. A line that is not a request gets a failure when its id can be read,
/// and no answer when it cannot.
pub fn parse_line(line: &str) -> Result<Request, Option<Response>> {
    match serde_json::from_str::<Request>(line) {
        Ok(request) => Ok(request),
        Err(_) => {
            let id = serde_json::from_str::<Value>(line)
                .ok()
                .and_then(|v| v.get("id").and_then(Value::as_u64));
            Err(id.map(|id| Response {
                id,
                result: Outcome::failure("invalid_request", "Invalid request"),
            }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_value_has_no_error_field() {
        let line = serde_json::to_value(Outcome::value(json!([1, 2]))).unwrap();
        assert_eq!(line, json!({ "ok": true, "value": [1, 2] }));
    }

    #[test]
    fn a_failure_has_no_value_field() {
        let line = serde_json::to_value(Outcome::failure("unknown_method", "x.y")).unwrap();
        assert_eq!(
            line,
            json!({ "ok": false, "error": { "code": "unknown_method", "message": "x.y" } })
        );
    }

    #[test]
    fn a_request_without_input_or_actor_reads() {
        let request = parse_line(r#"{"id":3,"method":"app.licenses"}"#).unwrap();
        assert_eq!(request.id, 3);
        assert_eq!(request.input, Value::Null);
        assert_eq!(request.actor, None);
    }

    #[test]
    fn a_request_with_an_actor_reads() {
        let request = parse_line(
            r#"{"id":1,"method":"m","input":{"a":1},"actor":{"id":"d","name":"Phone"}}"#,
        )
        .unwrap();
        assert_eq!(
            request.actor,
            Some(Actor {
                id: "d".into(),
                name: "Phone".into()
            })
        );
    }

    #[test]
    fn a_bad_line_with_an_id_gets_a_failure() {
        let response = parse_line(r#"{"id":7,"method":5}"#).unwrap_err().unwrap();
        assert_eq!(response.id, 7);
        assert_eq!(response.result.error.unwrap().code, "invalid_request");
    }

    #[test]
    fn a_line_with_no_id_gets_no_answer() {
        assert!(parse_line("not json").unwrap_err().is_none());
    }
}
