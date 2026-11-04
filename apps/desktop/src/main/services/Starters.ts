import {
  type Agent,
  type AgentStarterCreate,
  ROUTINES_MAX,
  STARTER_ROUTINE_SCHEDULE,
  skillName,
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
   *
   * The strings of the routine and the skill come with the request, in the language of the pick.
   * This process holds no text catalogue. The request is checked before anything is made. The
   * schedule, the pause and the place are set here, never by the request.
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
       * The routines of a server, a paused one too. A starter checks the limit of 50 before it
       * makes the routine, so that the chat of the new agent can say that the limit is why (the
       * service of routines refuses the 51st routine too, for every other way in).
       */
      const routineCount = (serverId: string) =>
        db.get<{ n: number }>("SELECT COUNT(*) AS n FROM routine WHERE server_id = ?", serverId)
          ?.n ?? 0

      return Starters.of({
        create: (input) =>
          Effect.gen(function* () {
            const { starter, ...form } = input
            const agent = yield* agents.create(form)

            if (starter.routine) {
              const routine = starter.routine
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
                  name: routine.name.trim(),
                  why: failure,
                })
            }

            if (starter.skill) {
              const skill = starter.skill
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
                  name: skillName(skill.name),
                  why: failure,
                })
            }
            return agent
          }),
      })
    }),
  )
}
