import type { WorkflowGraph } from "@robot/shared"
import { Effect } from "effect"
import type { ProvidersService } from "./Providers.ts"

/**
 * The test of the models of a graph change (spec 002, 006, 010): a text node may name a model only
 * when its account is connected and offers that model, and a reasoning level only when the model
 * takes it. A node that a change does not touch is not tested. Returns a plain text for the first
 * fault, or null. The proposals and the chat tools use this one function.
 */
export const modelsOfferedBy =
  (providers: Pick<ProvidersService, "accounts" | "models">) =>
  (before: WorkflowGraph, after: WorkflowGraph): Effect.Effect<string | null> =>
    Effect.gen(function* () {
      const old = new Map(before.nodes.map((n) => [n.id, n]))
      for (const n of after.nodes) {
        if (n.kind !== "text") continue
        const was = old.get(n.id)
        const same =
          was !== undefined &&
          was.accountId === n.accountId &&
          was.model === n.model &&
          was.effort === n.effort
        if (same) continue
        if (n.accountId === null && n.model === null && n.effort === null) continue
        if (n.accountId === null || n.model === null)
          return `Node ${n.number}: set the account and the model together.`
        const account = (yield* providers.accounts).find((a) => a.id === n.accountId)
        if (!account?.connected) return `Node ${n.number}: the account is not connected.`
        const models = yield* providers.models(n.accountId).pipe(Effect.orElseSucceed(() => null))
        if (models === null)
          return `Node ${n.number}: the models of the account could not be read now.`
        const info = models.find((m) => m.id === n.model)
        if (!info) return `Node ${n.number}: the account does not offer the model "${n.model}".`
        if (n.effort !== null && !info.efforts.includes(n.effort))
          return `Node ${n.number}: the model "${n.model}" does not take the reasoning level "${n.effort}".`
      }
      return null
    })
