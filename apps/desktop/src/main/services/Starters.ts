import {
  type Agent,
  type AgentStarterCreate,
  ROUTINES_MAX,
  STARTER_ROUTINE_SCHEDULE,
  starterText,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Agents } from "./Agents.ts"
import { Chat } from "./Chat.ts"
import { Database } from "./Database.ts"
import type { AppError } from "./errors.ts"
import { Routines } from "./Routines.ts"
import { Skills } from "./Skills.ts"

export interface StartersService {
  /**
   * Makes the agent of the form, and then the extra setup of its starter: a paused routine that
   * posts in the chat of the agent (spec 009), and a skill for this agent only that is on (spec
   * 017). At 50 routines or 100 skills that part is not made. The agent is made in every case,
   * and the first notes in its chat say what was not made and why (spec 002, "Starters").
   */
  create(input: AgentStarterCreate): Effect.Effect<Agent, AppError>
}

export class Starters extends Context.Service<Starters, StartersService>()("robot/main/Starters") {
  static readonly layer = Layer.effect(
    Starters,
    Effect.gen(function* () {
      const db = yield* Database
      const agents = yield* Agents
      const routines = yield* Routines
      const skills = yield* Skills
      const chat = yield* Chat

      /**
       * The routines of a server, a paused one too. The limit of 50 is checked here, because the
       * routine form does not refuse the 51st routine yet (slice S29).
       */
      const routineCount = (serverId: string) =>
        db.get<{ n: number }>("SELECT COUNT(*) AS n FROM routine WHERE server_id = ?", serverId)
          ?.n ?? 0

      return Starters.of({
        create: (input) =>
          Effect.gen(function* () {
            const { starter, ...form } = input
            const agent = yield* agents.create(form)
            const text = starterText(starter.locale, starter.id)

            if (text.routine) {
              const routine = text.routine
              const failure: "limit" | "error" | null =
                routineCount(agent.serverId) >= ROUTINES_MAX
                  ? "limit"
                  : yield* routines
                      .create(
                        {
                          serverId: agent.serverId,
                          agentId: agent.id,
                          name: routine.name,
                          prompt: routine.prompt,
                          schedule: STARTER_ROUTINE_SCHEDULE,
                          place: { kind: "agent" },
                        },
                        { paused: true },
                      )
                      .pipe(
                        Effect.map(() => null),
                        Effect.catch(() => Effect.succeed("error" as const)),
                      )
              if (failure)
                chat.note(agent.id, {
                  kind: "note",
                  note: "starter_not_made",
                  what: "routine",
                  name: routine.name,
                  why: failure,
                })
            }

            if (text.skill) {
              const skill = text.skill
              const failure = yield* skills
                .createForAgent(
                  agent.id,
                  {
                    name: skill.name,
                    description: skill.description,
                    instructions: skill.instructions,
                  },
                  { numbered: true },
                )
                .pipe(
                  Effect.map(() => null),
                  Effect.catch((error) =>
                    Effect.succeed(
                      error.code === "skills_full" ? ("limit" as const) : ("error" as const),
                    ),
                  ),
                )
              if (failure)
                chat.note(agent.id, {
                  kind: "note",
                  note: "starter_not_made",
                  what: "skill",
                  name: skill.name,
                  why: failure,
                })
            }
            return agent
          }),
      })
    }),
  )
}
