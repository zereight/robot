# Glossary

The words that the user reads, in English and Korean. Specs and interface text use these words.
A new word goes here in the same pull request as the spec that brings it.

- **Korean** is the word in the translation catalogue today. "—" means that no key holds the word
  yet. A spec author may then give a proposal, marked "(proposed)". The implementer adds the key
  and updates this list.
- **Avoid** lists words that mean something else in ROBot, or that break a rule of 000.

## Things the user owns

| Term | Meaning | Korean | Avoid |
| --- | --- | --- | --- |
| Agent | A member that does work, with a face, name, role line, model, workspace and memory (002). | 에이전트 | bot (except the bot tag), assistant, employee, coworker |
| Main agent | The one agent that can split work across the others (002). | — | boss, manager |
| Role line | The short line under the name of an agent (002). | 역할 | job title |
| Instructions | The text that an agent follows in every turn (002). | 지침 | prompt, soul, persona |
| Workspace | The folder of an agent (007). | 작업 폴더 | project, sandbox |
| Memory | Short facts that an agent keeps between chats (008). | 메모리 | brain, learning |
| Proposal | A fact that an agent suggests and the user has not accepted (008). | 제안 | memory (a proposal is not memory) |
| Knowledge | Linked articles that an agent writes and reads again (016). | 지식 | memory, wiki |
| Skill | Saved instructions that the user calls with a slash (017). The text of a skill is its "instructions" (지시 사항), apart from the instructions of an agent (지침). | 스킬 | plugin, tool |
| Connection | An outside tool provider that speaks MCP (018). | 연결 | integration, app, plugin |
| Tool search | The step "Search tools", with which an agent finds the tools of its connections when it may use more than 20 (018). | 도구 검색 (proposed) | lookup, discover, browse |
| Saved secret | A key or password that an agent uses and the model never sees (020). | 저장된 비밀 값 | credential, token |
| Saved login | A user name and a password for a site, which the browser of an agent fills in. The model never sees them (020). | 저장된 로그인 (proposed) | credential, account |
| Model account | A provider or a vendor program that the user signed in to (006). | 모델 계정 | provider (in interface text), subscription |
| Backup model | The model that an agent uses while its main model is held (006). | 백업 모델 (proposed) | fallback, failover |
| Held model | A main model that the app does not use until a reset time, because its limit is spent (006). | 보류된 모델 (proposed) | blocked, banned |
| ACP program | A program that speaks the Agent Client Protocol and that the user adds as an agent runtime (006). | ACP 프로그램 (proposed) | plugin, integration |
| Older models | The folded group of the model picker for models that have a newer version (006). | 이전 모델 (proposed) | legacy, deprecated |
| Permission level | How much an agent may do before it asks (007). | 권한 수준 | mode, autonomy |
| Ask when unsure | The level at which the decision model checks a risky step against the words of the user (007). | 확실하지 않을 때만 확인 (proposed) | auto mode, autopilot |
| Permission checks | The switch that lets the decision model check steps (013). | 권한 판단 (proposed) | classifier, guard |
| Read-only mark | The mark of a connection that a tool changes nothing (018). | 읽기 전용 표시 (proposed) | safe tool |
| Handbook | One text that every agent of a server reads (002). | 핸드북 (proposed) | company docs, soul, system prompt |
| Channel instructions | The text that each member reads in turns of one channel (004). | 채널 지침 (proposed) | channel prompt |
| Channel note | A memory item of an agent for one channel (008). | 채널 메모 (proposed) | group memory |
| Memory check | A short turn that suggests facts that an agent did not save (008). | 메모리 점검 (proposed) | reflection, learning |
| Token limit | The most tokens that one run of a routine may use (009). | 토큰 한도 (proposed) | budget (ROBot shows no money limit) |
| Outside program | A program on this computer that reads and sends work in ROBot through MCP (023). | 외부 프로그램 (proposed) | integration, API client |
| Helper | The small program of ROBot that an outside program starts (023). | 도우미 프로그램 (proposed) | bridge, server, agent |
| Access key | The secret that tells ROBot which outside program calls (023). | 접근 키 (proposed) | token, password |
| Read, Read and send work | The two accesses of an outside program (023). | 읽기, 읽기와 작업 보내기 (proposed) | read-only, full access |
| Trust read-only marks | The switch of a connection that lets marked tools run with no card (018). | 읽기 전용 표시 믿기 (proposed) | safe mode |
| Read the handbook | The switch of an agent that gives it the handbook (002). | 핸드북 읽기 (proposed) | — |
| Cached share | Cached input divided by all input, in percent (005). | 캐시 비율 (proposed) | cache hit rate |
| Holds outside content | The mark of a chat, thread or channel whose turns still see outside text (007). | 바깥 내용 포함 (proposed) | tainted, unsafe |
| Program mark | The part of that mark that says the text came from an outside program (007, 023). Not shown as a word in the interface. | — | — |
| Action log | The list of tool steps and who decided them (007). | 작업 기록 | history, audit |
| Profile | A separate space on one computer (022). | 프로필 | account, user, workspace |
| Handover | A new thread in the chat of another agent, with a brief of the first chat (003). | 인계 (proposed) | transfer, delegate |
| Brief | The text of the handover card. The app writes it from the chat, with no model (003). | 인계 요약 (proposed) | summary (a summary belongs to a compact) |
| Reviewed tools, held tool | The tools of a connection that the user accepted, and a tool that waits for the user because it is new or changed (018). | 검토한 도구, 검토 대기 도구 (proposed) | blocked tool, quarantined tool |
| Token savings | The settings section with three switches that cut repeated work (026). | 토큰 절약 (proposed) | boost, turbo, optimizer |
| Check with edit | A saving: a file change carries one shell command (026). | 편집과 함께 확인 (proposed) | fused action |
| Set big results aside | A saving: the program keeps a copy of a big result and takes it out of the context (026). | 큰 결과 따로 보관 (proposed) | cache, archive, trim |
| Compact at finished steps | A saving: the app compacts the context when the agent finishes a listed step (026). | 단계가 끝나면 압축 (proposed) | auto-compact |
| Set-aside result | The whole text of a result that a saving took out of the context (026). | 따로 보관한 결과 (proposed) | cache, archive |
| Savings line | The line in a task that counts how often the savings ran (026). | 절약 내역 (proposed) | saved tokens |

## Places and work

| Term | Meaning | Korean | Avoid |
| --- | --- | --- | --- |
| Server | A computer that runs agents, as shown on the rail (000). | 서버 | environment, host |
| Linked device | A phone or computer paired with a server (012). | 연결된 기기 | remote, client |
| Direct chat | A conversation of the user and one agent (003). | 일대일 채팅 | DM, session |
| Thread | A branch of a direct chat (003). | 스레드 | session |
| Compact | To replace the older part of a conversation with a summary, for the model (003). The chat keeps its rows and shows the line "Compacted". | 압축 | delete, clear, trim, compact place list (a different setting, 013) |
| Compacted | The line in a chat that marks where a compact happened. It opens to the summary (003). | 압축됨 | summarised, deleted |
| Context meter | The ring in the chat header that shows how much of the context of the model a conversation uses (003). | 컨텍스트 사용량 | token counter |
| Run next | The action that moves a queued task to the front of the order (005). | 먼저 실행 | priority, jump the queue |
| Main thread | The direct chat itself. It cannot be archived or deleted (003). | 메인 대화 | default thread |
| Message queue | The short list of messages above the message box that wait for the end of a turn (003). | 메시지 대기열 | task queue |
| Slot | One of the tasks that can run at the same time, set by "Agents working at once" (005, 013). | 실행 자리 | place, worker |
| Agents working at once | The setting for the number of slots (013). | 동시에 일하는 에이전트 수 | concurrency, workers |
| Channel | A conversation of the user and several agents (004). | 채널 | room, group |
| Lead | The agent that splits a channel job (004). | 리드 | foreman, manager |
| Part | One piece of a channel job, for one member (004). | 부분 | subtask, ticket |
| Done test | The check that the lead writes for a part (004). | 완료 기준 | acceptance criteria |
| Verdict | The judgement of the lead on a done test (004). | 판정 | score, grade |
| Met, Not met | The two verdicts (004). | 충족, 미충족 | pass, fail |
| Task | One piece of work of one agent (005). | 작업 | job, run (except for a routine run) |
| Turn | One request and the work of the agent that follows it, until the reply ends (003, 005). | — | message, session |
| Blocked | A task that ended because the agent could not do the work (005). | 막힘 | failed (a blocked task did not fail) |
| In review | A part that waits for the user to accept it (004, 005). | 검토 중 | pending, done |
| Answered by the lead | The mark of a question of a member that the lead answered in place of the user (004). | 리드가 답함 (proposed) | auto answer, bot answer |
| Shared folder | A workspace that two or more agents use (025). | 공유 폴더 (proposed) | shared workspace, project |
| File claim | The mark that a task holds on a file that it changed in a shared folder (025). The interface says "in use by". | 사용 중 (proposed) | lock |
| Own copy | A separate working copy of a Git repository that one part of a channel job uses (025). | 별도 사본 (proposed) | worktree, clone, fork (a fork is a chat copy, 003), sandbox |
| Branch of a part | The new Git branch of an own copy (025). | 부분 브랜치 (proposed) | — |
| Silent limit | How long a turn may show no sign of life before the app stops it (005). | 응답이 없는 작업을 멈추는 시간 (setting label) | timeout |
| Quiet line | The line "No answer from <name> for <time>" for a turn that shows no sign of life (005). | "<name>에서 <time> 동안 응답이 없어요" (proposed) | stuck, frozen, error |
| Routine | A task that runs on a schedule or a watch (009). | 루틴 | job, cron, automation |
| Record only | A switch of a watch routine or a workflow trigger: a change or a trigger starts no task and calls no model, and only shows as "Recorded" (spec question of 009, 010). | 기록만 하기 | dry run, observe mode, test mode |
| Recorded | A run of "Record only": what fired, with no task (spec question of 009, 010). | 기록됨 | skipped, ignored |
| Workflow | Connected steps that run when a trigger fires (010). | 워크플로, 워크플로우 (see "Open points") | automation, pipeline |
| Starter | A ready setup for one job. It fills the new agent form (002) or makes a workflow (010). | — (proposed: 스타터) | template, preset |
| Today | The page of what waits, went wrong, ran and runs next (021). | 오늘 | inbox, dashboard |
| Needs you | Items that wait for the user (011, 021). | 내 확인이 필요해요 | inbox |
| Board | The page of cards in four columns (024). | 보드 (proposed) | kanban (as a name in the interface), project |
| Card | One piece of planned work on the board (024). | 카드 (proposed) | ticket, issue, task (a card is not a task) |
| Work card | A card that the board makes by itself for a task that has no card (024). | 진행 중인 작업 카드 (proposed) | planned card, ticket |
| Backlog, To do, Doing, Done | The four columns of the board (024). Agents leave "Backlog" alone. | 백로그, 할 일, 진행 중, 완료 (proposed) | In progress, Review |
| Mine | The switch of a card that the user does alone. Agents do not see it (024). | 내가 할 일 (proposed) | Human, private |
| Decision model | A small, fast model that the user sets up for quick choices (013). | — | classifier, router |
| Sync | Two computers that hold the same data (019). | 동기화 | backup, mirror |
| Keep going | The app asks an agent to go on when a turn ends with open steps (005). | 이어서 진행 (proposed) | autopilot, auto-run |
| Web hook | A trigger of a workflow: an address on this computer that an outside service calls (010). | 웹훅 (proposed) | endpoint, API |
| Pinned | A place that the user keeps at the top of the place list (001). | 고정됨 (proposed) | favourite, starred |
| Mark as unread | The action that makes a message and the later messages of agents count as unread again (003). | 읽지 않음으로 표시 (proposed) | flag |
| Dictate | Speech that becomes text in the message box (027). | 받아쓰기 (proposed) | transcribe |
| Read aloud | The app speaks a finished message of an agent (027). | 소리 내어 읽기 (proposed) | narrate, TTS |
| Voice chat | A spoken talk with one agent on the phone (027). | 음성 대화 (proposed) | call |
| Menu bar item | The small icon of the app in the menu bar of the Mac (015). | 메뉴 막대 항목 (proposed) | tray, widget |
| Recogniser | The speech recognition of the system of a device. It must run on the device (027). | 음성 인식기 (proposed) | speech service |
| Limit reason | The plan limit, the credit or the quota is spent. It moves an agent to its backup model (006). | 한도 소진 (proposed) | error |
| Image stack | The stack of cards that shows more than one image of a message on the phone (011). | 이미지 묶음 (proposed) | gallery |
| Thinking sheet | The sheet on the phone that lists all thoughts of a turn (011). | 생각 보기 (proposed) | log |
| Share to an agent | The target of the share sheet of the phone that sends an item to an agent (011). | 에이전트에게 공유 (proposed) | export |
| Find in the chat | The bar of Cmd+F that finds text in the chat that is open (003). | 대화에서 찾기 (proposed) | search (search is Cmd+K, 001) |
| Sound when a task ends | The setting for the sound of a result (015). | 작업이 끝날 때 소리 (proposed) | alert |
| Keep phones quiet | The setting that holds notices to phones while the user works at the computer (015). | 일하는 동안 폰 알림 보류 (proposed) | focus mode |
| Sensitive read | A step that reads a place with keys or logins. The turn then holds a mark (007). | 민감한 정보 읽기 | leak, breach |
| Control place | A place that starts a program later or gives access to the computer. A change there is a hard step (007). | 제어 위치 (proposed) | system folder |
| Teams link | The link between one Microsoft Teams chat and one agent or one channel. It is off at first (028). | Teams 연동 (proposed) | bridge, bot, connection (that is 018), integration |
| Allowed senders | The names of the people in a Teams chat whose messages the app answers (028). | 허용된 보낸 사람 (proposed) | allowlist, whitelist, users |
| Call text | The text that a message of a Teams chat must hold to call the app, for example "@ROBot" (028). | 호출 문구 (proposed) | trigger, keyword, prefix |
| Marker | The text at the start of every message that the app writes in Teams. The app never reads a message with it (028). | 표시 문구 (proposed) | tag, signature |
| From Teams | The mark of a message that came from a Teams chat. The source of its task is "Teams" (028, 005). | Teams에서 보냄 (proposed) | Sent by (that is 023) |
| Browser profile | A named set of saved sign-ins on this computer, which agents can share. The interface says "Browser profile" or "Browser", and the texts say "sign-ins" (spec questions of 007, 002, 022). | 브라우저 프로필 | account, session |

## Words that ROBot does not use

- "Learns", "trains", "evolves", "gets smarter" about an agent or a model. An agent gets better
  only through things that the user can see and edit (000).
- "Hire", "fire", "employee", "coworker" for an agent. The words "agent", "member" and "New agent"
  stay (see `docs/spec-changes.md`, "Decided against").
- "Autonomous" and "24/7". ROBot runs while the computer runs.
- "Bot" as a name for an agent. "Bot" is only the tag beside the name.

## Open points

- "연결" names a connection (018) and is part of "연결된 기기" (012). A user can confuse the two in
  Korean. A spec author decides which word changes.
- The catalogue writes both "워크플로" (for example the page title) and "워크플로우" (for example
  the tab and the list). One spelling should stay.
- "Profile" (프로필) names the profile tab of an agent (002) and a profile of 022. One of the two
  needs another word, in English and in Korean.
- "작업 기록" (Action log) stands next to "작업" (Task) and "최근 작업" (Recent work), so a user can
  read it as a record of tasks.
