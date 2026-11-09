// Model of specs/005-tasks.md: task states, slots, and the queue of one workflow in one profile.
// It checks the rules of "States and reasons", "Queue" and "Rules". Order of the queue ("Run next",
// user runs before trigger runs), usage, times and the limits of a turn are not in the model.
module tasks {
  type Status = Queued | Running | Waiting | Done | Failed | Blocked | Cancelled
  type Task = { wf: str, status: Status, held: bool }

  const SLOTS: int
  const QUEUE_LIMIT: int
  const WORKFLOWS: Set[str]
  pure val MAX_TASKS = 7

  var tasks: int -> Task
  var nextId: int
  /// The final state of a task, written when the task ends. It checks that no later step changes it.
  var closed: int -> Status

  pure def isFinal(s: Status): bool = or { s == Done, s == Failed, s == Blocked, s == Cancelled }

  /// A task that runs, waits for the user, or waits for a slot after an answer keeps its workflow busy.
  pure def holds(t: Task): bool = or {
    t.status == Running,
    t.status == Waiting,
    and { t.status == Queued, t.held },
  }

  def runningCount: int = tasks.keys().filter(i => tasks.get(i).status == Running).size()
  def busy(wf: str): bool = tasks.keys().exists(i => and { tasks.get(i).wf == wf, holds(tasks.get(i)) })
  def queued(wf: str): int =
    tasks.keys().filter(i => and { tasks.get(i).wf == wf, tasks.get(i).status == Queued }).size()

  action init = all {
    tasks' = Map(),
    nextId' = 0,
    closed' = Map(),
  }

  action add(wf: str): bool = all {
    nextId < MAX_TASKS,
    queued(wf) < QUEUE_LIMIT,
    tasks' = tasks.put(nextId, { wf: wf, status: Queued, held: false }),
    nextId' = nextId + 1,
    closed' = closed,
  }

  action begin(id: int): bool = all {
    tasks.keys().contains(id),
    tasks.get(id).status == Queued,
    runningCount < SLOTS,
    or { tasks.get(id).held, not(busy(tasks.get(id).wf)) },
    tasks' = tasks.set(id, { ...tasks.get(id), status: Running, held: false }),
    nextId' = nextId,
    closed' = closed,
  }

  action askUser(id: int): bool = all {
    tasks.keys().contains(id),
    tasks.get(id).status == Running,
    tasks' = tasks.set(id, { ...tasks.get(id), status: Waiting }),
    nextId' = nextId,
    closed' = closed,
  }

  /// With no free slot the task is queued at the front, and its workflow stays held.
  action answer(id: int): bool = all {
    tasks.keys().contains(id),
    tasks.get(id).status == Waiting,
    tasks' = tasks.set(id, {
      ...tasks.get(id),
      status: if (runningCount < SLOTS) Running else Queued,
      held: runningCount >= SLOTS,
    }),
    nextId' = nextId,
    closed' = closed,
  }

  action finish(id: int, outcome: Status): bool = all {
    or { outcome == Done, outcome == Failed, outcome == Blocked },
    tasks.keys().contains(id),
    tasks.get(id).status == Running,
    tasks' = tasks.set(id, { ...tasks.get(id), status: outcome }),
    nextId' = nextId,
    closed' = closed.put(id, outcome),
  }

  action stop(id: int): bool = all {
    tasks.keys().contains(id),
    not(isFinal(tasks.get(id).status)),
    tasks' = tasks.set(id, { ...tasks.get(id), status: Cancelled, held: false }),
    nextId' = nextId,
    closed' = closed.put(id, Cancelled),
  }

  action retry(id: int): bool = all {
    tasks.keys().contains(id),
    or { tasks.get(id).status == Failed, tasks.get(id).status == Blocked, tasks.get(id).status == Cancelled },
    add(tasks.get(id).wf),
  }

  /// After a restart every task that has not ended is Failed, also one that waits for the user.
  action restart: bool = all {
    tasks.keys().exists(i => not(isFinal(tasks.get(i).status))),
    tasks' = tasks.keys().mapBy(i =>
      if (isFinal(tasks.get(i).status)) tasks.get(i)
      else { ...tasks.get(i), status: Failed, held: false }
    ),
    nextId' = nextId,
    closed' = tasks.keys()
      .filter(i => not(isFinal(tasks.get(i).status)))
      .fold(closed, (m, i) => m.put(i, Failed)),
  }

  action step = {
    nondet wf = WORKFLOWS.oneOf()
    nondet id = 0.to(MAX_TASKS - 1).oneOf()
    any {
      add(wf),
      begin(id),
      askUser(id),
      answer(id),
      finish(id, Done),
      finish(id, Failed),
      finish(id, Blocked),
      stop(id),
      retry(id),
      restart,
    }
  }

  val slotsHold: bool = runningCount <= SLOTS
  val oneAtATime: bool = WORKFLOWS.forall(wf =>
    tasks.keys().filter(i => and { tasks.get(i).wf == wf, holds(tasks.get(i)) }).size() <= 1
  )
  val queueHolds: bool = WORKFLOWS.forall(wf => queued(wf) <= QUEUE_LIMIT)
  val finalsStay: bool = closed.keys().forall(i => tasks.get(i).status == closed.get(i))
  val finalsClosed: bool =
    tasks.keys().forall(i => isFinal(tasks.get(i).status) == closed.keys().contains(i))
  val heldOnlyQueued: bool =
    tasks.keys().forall(i => or { not(tasks.get(i).held), tasks.get(i).status == Queued })
}

module check {
  import tasks(SLOTS = 2, QUEUE_LIMIT = 2, WORKFLOWS = Set("a", "b", "c")).*
}

module scenarios {
  import tasks(SLOTS = 1, QUEUE_LIMIT = 2, WORKFLOWS = Set("a", "b")).*

  /// Acceptance of 005: the number is 1, A waits for an approval, another workflow takes the slot,
  /// the user allows A. A is queued with its workflow held.
  run answerWithoutSlotTest = {
    init
      .then(add("a"))
      .then(begin(0))
      .then(askUser(0))
      .then(add("b"))
      .then(begin(1))
      .then(answer(0))
      .expect(and { tasks.get(0).status == Queued, tasks.get(0).held, slotsHold })
  }

  /// The held task runs when the slot is free, before a later task of its workflow.
  run heldTaskRunsFirstTest = {
    init
      .then(add("a"))
      .then(begin(0))
      .then(askUser(0))
      .then(add("b"))
      .then(begin(1))
      .then(answer(0))
      .then(add("a"))
      .then(finish(1, Done))
      .then(begin(0))
      .expect(and { tasks.get(0).status == Running, tasks.get(2).status == Queued })
  }

  /// While the held task waits, a later task of its workflow cannot take the free slot.
  run heldTaskBlocksItsWorkflowTest = {
    init
      .then(add("a"))
      .then(begin(0))
      .then(askUser(0))
      .then(add("b"))
      .then(begin(1))
      .then(answer(0))
      .then(add("a"))
      .then(finish(1, Done))
      .then(begin(2))
      .fail()
  }

  /// A waiting task uses no slot, so a task of another workflow runs.
  run waitingTaskFreesItsSlotTest = {
    init
      .then(add("a"))
      .then(begin(0))
      .then(askUser(0))
      .then(add("b"))
      .then(begin(1))
      .expect(tasks.get(1).status == Running)
  }

  /// A waiting task keeps its workflow busy, so a second task of that workflow stays queued.
  run waitingTaskHoldsItsWorkflowTest = {
    init
      .then(add("a"))
      .then(begin(0))
      .then(askUser(0))
      .then(add("a"))
      .then(begin(1))
      .fail()
  }

  run queueLimitTest = {
    init
      .then(add("a"))
      .then(add("a"))
      .then(add("a"))
      .fail()
  }

  /// Open question for 005: a task that waits for the user is not queued and does not count. The
  /// same task, queued again after the answer, is a queued task. Read strictly, the queue then
  /// holds QUEUE_LIMIT + 1 tasks. `queueHolds` is left out of the invariants of the random run
  /// until the spec says what happens here.
  run heldTaskExceedsQueueLimitTest = {
    init
      .then(add("a"))
      .then(begin(0))
      .then(askUser(0))
      .then(add("a"))
      .then(add("a"))
      .then(add("b"))
      .then(begin(3))
      .then(answer(0))
      .expect(not(queueHolds))
  }

  run restartFailsEveryOpenTaskTest = {
    init
      .then(add("a"))
      .then(begin(0))
      .then(askUser(0))
      .then(add("b"))
      .then(restart)
      .expect(and { tasks.get(0).status == Failed, tasks.get(1).status == Failed, finalsStay, finalsClosed })
  }

  run retryMakesANewTaskTest = {
    init
      .then(add("a"))
      .then(begin(0))
      .then(finish(0, Failed))
      .then(retry(0))
      .expect(and { tasks.get(0).status == Failed, tasks.get(1).status == Queued, tasks.get(1).wf == "a" })
  }
}
