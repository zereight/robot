import type { McpOpener, McpSession, McpSpec, McpTool } from "./mcp.ts"

/**
 * A stand-in for the way to reach a connection, for unit tests of the services (spec 018). A test
 * sets the tools and what a call does. It is not used by the app.
 */
export const tool = (name: string, over: Partial<McpTool> = {}): McpTool => ({
  name,
  description: `The tool ${name}.`,
  readOnly: false,
  schema: { type: "object", properties: {} },
  ...over,
})

export const standIn = (tools: McpTool[]) => {
  const state = {
    tools,
    /** The reason that the next opens fail with, or undefined. */
    fail: undefined as Error | undefined,
    /** An open waits for this before it answers: a start that takes a long time. */
    hold: undefined as Promise<void> | undefined,
    opened: [] as McpSpec[],
    closed: 0,
    calls: [] as { name: string; args: Record<string, unknown> }[],
    answer: (async (name: string) => ({ text: `ran ${name}`, isError: false })) as (
      name: string,
      args: Record<string, unknown>,
      options: { signal: AbortSignal; timeoutMs: number },
    ) => Promise<{ text: string; isError: boolean }>,
  }
  const open: McpOpener = async (spec) => {
    state.opened.push(spec)
    if (state.hold) await state.hold
    if (state.fail) throw state.fail
    let end: () => void = () => {}
    const closed = new Promise<void>((resolve) => {
      end = resolve
    })
    const session: McpSession = {
      closed,
      close: () => {
        state.closed++
        end()
      },
      listTools: async () => ({ tools: state.tools, more: false }),
      call: async (name, args, options) => {
        state.calls.push({ name, args })
        return await state.answer(name, args, options)
      },
    }
    return session
  }
  return { state, open }
}
