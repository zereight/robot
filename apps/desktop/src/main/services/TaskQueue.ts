import { Context, Effect, Layer } from "effect"
import { EventBus } from "./EventBus.ts"
import { QuietClock } from "./quietClock.ts"
import { SettingsStore } from "./Settings.ts"
import { TaskScheduler } from "./taskScheduler.ts"

/**
 * The queue and the slots of the tasks, and the quiet clock of the turns (spec 005). The engine
 * of the runs (`Runs`) and the Tasks page (`Tasks`) share this one object.
 */
export interface TaskQueueService {
  readonly scheduler: TaskScheduler
  readonly quiet: QuietClock
  /** "Tasks at once" now (spec 013). */
  readonly slots: () => number
}

export class TaskQueue extends Context.Service<TaskQueue, TaskQueueService>()(
  "robot/main/TaskQueue",
) {
  static readonly layer = Layer.effect(
    TaskQueue,
    Effect.gen(function* () {
      const settings = yield* SettingsStore
      const bus = yield* EventBus
      const slots = () => Effect.runSync(settings.get).tasksAtOnce
      const scheduler = new TaskScheduler(slots)
      const quiet = new QuietClock((change) => bus.emit("tasks.quiet", change))
      // A new number applies at once to the tasks that wait; a task that runs is never stopped.
      bus.tap((event) => {
        if (event === "settings.changed") scheduler.refresh()
      })
      return TaskQueue.of({ scheduler, quiet, slots })
    }),
  )
}
