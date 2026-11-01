/** Information about the running app. */
export interface AppInfo {
  readonly name: string
  readonly version: string
  readonly platform: string
}

/**
 * Request methods that the renderer can call in the main process.
 * Each entry maps a method name to its input and output.
 */
export interface RpcMethods {
  "app.info": { input: undefined; output: AppInfo }
}

/** Events that the main process pushes to the renderer. */
export type RpcEvents = Record<never, never>

export type RpcMethod = keyof RpcMethods
export type RpcInput<M extends RpcMethod> = RpcMethods[M]["input"]
export type RpcOutput<M extends RpcMethod> = RpcMethods[M]["output"]
export type RpcEvent = keyof RpcEvents

/** Result envelope that crosses the process boundary. Errors are plain data. */
export type RpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RpcError }

export interface RpcError {
  readonly code: string
  readonly message: string
}

/** The bridge that the preload script exposes on `window.robot`. */
export interface RobotBridge {
  invoke<M extends RpcMethod>(method: M, input: RpcInput<M>): Promise<RpcResult<RpcOutput<M>>>
  on<E extends RpcEvent>(event: E, listener: (payload: RpcEvents[E]) => void): () => void
}

export const INVOKE_CHANNEL = "robot:invoke"
export const EVENT_CHANNEL = "robot:event"
