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
| Saved secret | A key or password that an agent uses and the model never sees (020). | 저장된 비밀 값 | credential, token |
| Model account | A provider or a vendor program that the user signed in to (006). | 모델 계정 | provider (in interface text), subscription |
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
| Action log | The list of tool steps and who decided them (007). | 작업 기록 | history, audit |
| Profile | A separate space on one computer (022). | 프로필 | account, user, workspace |

## Places and work

| Term | Meaning | Korean | Avoid |
| --- | --- | --- | --- |
| Server | A computer that runs agents, as shown on the rail (000). | 서버 | environment, host |
| Linked device | A phone or computer paired with a server (012). | 연결된 기기 | remote, client |
| Direct chat | A conversation of the user and one agent (003). | 일대일 채팅 | DM, session |
| Thread | A branch of a direct chat (003). | — | session |
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
| Silent limit | How long a turn may show no sign of life before the app stops it (005). | 응답이 없는 작업을 멈추는 시간 (setting label) | timeout |
| Quiet line | The line "No answer from <name> for <time>" for a turn that shows no sign of life (005). | "<name>에서 <time> 동안 응답이 없어요" (proposed) | stuck, frozen, error |
| Routine | A task that runs on a schedule or a watch (009). | 루틴 | job, cron, automation |
| Workflow | Connected steps that run when a trigger fires (010). | 워크플로, 워크플로우 (see "Open points") | automation, pipeline |
| Today | The page of what waits, went wrong, ran and runs next (021). | 오늘 | inbox, dashboard |
| Needs you | Items that wait for the user (011, 021). | 내 확인이 필요해요 | inbox |
| Decision model | A small, fast model that the user sets up for quick choices (013). | — | classifier, router |
| Sync | Two computers that hold the same data (019). | 동기화 | backup, mirror |

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
