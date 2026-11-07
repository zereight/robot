import { Context, Effect, Layer } from "effect"
import { type BrowserWork, makeBrowserWork } from "./browserWork.ts"
import { EventBus } from "./EventBus.ts"
import { Platform } from "./Platform.ts"

/**
 * The browser work of the workflows (spec 007): idle work, the hold of the user, the address rule
 * of a page, and the close on Stop. The tools of a text node use it (`browserTools.ts`).
 */
export class Browsers extends Context.Service<Browsers, BrowserWork>()("robot/main/Browsers") {
  /** `options` lets a test keep the clock and the idle timer in its own hands. */
  static readonly layer = (options: { now?: () => number; sweepMs?: number } = {}) =>
    Layer.effect(
      Browsers,
      Effect.gen(function* () {
        const platform = yield* Platform
        const bus = yield* EventBus
        return Browsers.of(
          makeBrowserWork({
            platform,
            changed: (workflowId) => bus.emit("browser.changed", { workflowId }),
            ...options,
          }),
        )
      }),
    )
}
