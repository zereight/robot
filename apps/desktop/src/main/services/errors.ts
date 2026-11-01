import { Schema } from "effect"

/** A failure that the renderer can show. `code` selects the message; `detail` is extra context. */
export class AppError extends Schema.TaggedError<AppError>()("AppError", {
  code: Schema.String,
  detail: Schema.optionalKey(Schema.String),
}) {}

export class DatabaseError extends Schema.TaggedError<DatabaseError>()("DatabaseError", {
  message: Schema.String,
}) {}
