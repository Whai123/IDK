# AI Startup Workspace — vision draft

Status: the first independent prototype is implemented in this repository. See [the README](../README.md) for current behavior and real interface screenshots. This document records the broader product vision; the complete operating loop and comparative benefits still need a real mission trial.

## What the user has actually specified

- “always work”
- “เสนองาน” — proactively propose work.
- “if it need direction, ask me first” — ask the founder when work needs direction.
- The user accepted the five design improvements below and the founder-home structure: visible mission, direction requests, active work, verified deliveries, and next proposals.

Working interpretation: the team should keep advancing a project and discovering useful next steps within the direction the founder has given. When a task requires a missing or conflicting direction, ask before deciding that direction. Proposals remain distinct from assigned work; native execution in the prototype requires the founder to enable it.

## The promise

Give the workspace a repository, an ongoing mission, and constraints. The team keeps track of progress, proposes useful work, and advances assigned tasks. Direct it through one founder conversation, then review its product decisions, designs, code changes, test results, and launch materials.

The target user is a solo developer or small startup founder who can describe an outcome but needs help coordinating the work. The product succeeds when the founder spends less time managing agents and receives useful, verifiable results.

## The founder experience

1. Connect a repository and supported agent accounts. Choose a team preset and a usage budget.
2. Give an ongoing mission: “Help make this expense tracker easier for new users. Use the repository and supplied feedback to identify useful improvements.”
3. The product lead proposes concrete tasks with evidence, expected benefit, and acceptance criteria. For example, failed tests might support a duplicate-import repair; supplied support reports might support an import preview. The founder can change priorities and task scope.
4. Agents perform tasks within the given direction and hand work to one another. If a task needs a product direction or a choice between conflicting goals, they ask the founder before proceeding with that part. The founder can inspect a conversation, redirect a task, pause work, or replace an agent.
5. A delivery view presents the actual outputs, unresolved decisions, changes, and verification results. The founder accepts the result or requests another revision.
6. The team uses the result and new project signals to propose the next useful work. It retains prior decisions and dismissed proposals to avoid repeatedly suggesting the same task.

The main screen should answer four questions immediately: What are we trying to achieve? Who is doing what? What has actually been produced? What needs my decision?

## Accepted design direction

The user accepted these five improvements as the design direction. Detailed behavior, examples, and implementation choices still require design and validation.

1. **Keep the mission visible and link work to it.** Show the current goal, priorities, and success criteria above the work views. Each task and proposal explains which outcome it advances. For example, “Make a clean installation usable within two minutes” can be tested; “Improve the repo” needs more definition.
2. **Prepare decisions for the founder.** When direction is needed, present evidence, a recommendation, and the consequences of each realistic option. Include a small example or design draft when that helps the choice. Ask for direction without requiring the founder to reconstruct the agents' entire conversation.
3. **Make a change of direction understandable.** A founder update should produce a revised plan showing tasks that continue, tasks held for reconsideration, and new dependencies. Preserve useful completed work. Agents should pick up the updated shared decision before their next affected task; changing the goal should not silently leave old tasks running or discard all prior work.
4. **Learn from delivery and proposal feedback.** Record what was verified, what remains unknown, and what the outcome suggests doing next. Track rejected proposals and reasons. Measure customer impact only when actual feedback or usage data exists; a passing test establishes technical behavior, not adoption.
5. **Show the real operating state.** The interface should distinguish active work, a scheduled check, a task waiting for direction, and an interruption such as unavailable provider access. Preserve task state and support resuming within the established direction. Continue independent work when a single task is waiting.

Accepted founder-home structure: a visible mission followed by **Needs your direction**, **In progress**, **Delivered with evidence**, and **Proposed next**. Make tasks, artifacts, and the reasons for decisions easy to open from these views; conversations remain available as supporting detail.

Before calling this design better, test a real mission that includes discovering a useful task, delivering it, receiving a founder direction change, and continuing toward the revised goal. Evaluate founder effort, verified outcomes, and proposal usefulness alongside basic usability.

## Continuous work and proactive proposals

The proposed operating loop is: observe project signals, propose work, prioritize and assign, execute, verify, report, and revisit the mission.

- Watch supported changes such as repository updates, assigned issues, test failures, and supplied customer feedback. Scheduled reviews can revisit the backlog when there are no new events.
- Connect each proposal to the founder's mission and concrete evidence. Include the expected benefit, scope, approximate effort, and what would establish success. Do not invent customer findings from a repository alone.
- Keep a ranked proposal inbox separate from active assignments. Remember dismissed and deferred proposals, their reasons, and the condition that would make them relevant again.
- Advance runnable tasks according to the selected execution policy. When work is blocked or the budget is exhausted, show that state and what would allow progress.
- Report delivered outcomes and upcoming decisions in a digest. Activity should be judged by useful results and proposal quality rather than the number of messages or agent runs.

The prototype includes saved state, scheduled repository inspection, and native CLI task execution. The server must stay running for scheduled work. No paid model jobs were used to validate this implementation; strategic planning and customer-data integrations remain future work.

The user's selected rule is: ask the founder when direction is needed. The proposed implementation of that rule is to advance work within an established goal and constraints, and hold the dependent work when direction is missing. New proposals are assessed against those same boundaries before assignment.

For example, repairing a confirmed defect in an assigned feature can follow its existing acceptance criteria. Choosing a new target audience, introducing a paid product tier, or resolving conflicting product priorities requires founder direction. These examples illustrate the rule; they are not newly authorized tasks.

A direction request should explain what was found, why a decision is needed, the options, and the team's recommendation. Save the founder's answer as a shared decision. Continue independent assigned work while awaiting the answer, and avoid repeatedly asking a question that has already been resolved.

## A startup team, with configurable staffing

Roles describe responsibilities and outputs. Providers can be changed independently of roles; five Claude agents and five GPT agents would be one possible configuration. The ten-role list below is an initial repository-delivery preset, not a complete company organization or a fixed limit on departments.

### Proposed departments beyond development

The user asked about other startup departments, specifically marketing. The following is a proposed expansion of the design.

| Department | Ongoing responsibility | Reviewable outputs |
| --- | --- | --- |
| Product and research | Identify problems from actual feedback and keep priorities aligned with the mission | Research notes, opportunity proposals, product briefs |
| Design | Improve how users understand and use the product | Flows, prototypes, interface assets, usability findings |
| Engineering and QA | Build, maintain, and verify the product | Changes, previews, reproductions, test evidence |
| Marketing and growth | Explain the product, propose campaigns, and evaluate distribution experiments | Positioning drafts, demo scripts, landing-page copy, launch drafts, measurement reports |
| Sales and partnerships | Assess supplied leads and opportunities and prepare offers | Qualification notes, proposal drafts, partnership briefs |
| Customer support and success | Analyze actual support feedback and improve onboarding | Reply drafts, help articles, recurring-issue reports |
| Finance and operations | Track supplied costs and evaluate operating options | Budget summaries, pricing scenarios, operating plans |

Each department can contain several agents. Work and deliverables belong to the department; provider choice and active agent count depend on the task. A company overview should surface decisions and results across departments, with a department filter for its own mission, work, artifacts, and proposals.

### Marketing as a continuously responsible team

An illustrative marketing mission is: “Help solo developers understand this product and try it.” Its operating loop would be:

1. Review the current product, supplied feedback, accessible market information, and connected analytics. Keep missing data visible.
2. Propose an experiment tied to evidence, such as a clearer demo when the documentation lacks an example. State the expected outcome as a hypothesis, not an established customer finding.
3. Prepare concrete assets: positioning, a demo script, landing-page copy, a content plan, or a campaign draft. Coordinate with product and engineering so claims match verified capabilities.
4. Ask the founder when the task needs direction about audience, positioning, pricing, or a new campaign budget. Routine work continues within the existing mission; publication and external communication follow the founder's configured authority.
5. Evaluate the experiment using actual available results, then propose the next step. Without analytics or customer feedback, report prepared assets and untested assumptions rather than invented conversions or revenue.

For example, marketing could propose a short developer demo, design prepare the visuals, engineering supply a working example, and documentation update the quickstart. The founder would receive the coordinated deliverables and any direction request in the same home view. This is a proposed workflow, not activity already running in this environment.

| Role | Expected output |
| --- | --- |
| Product and business lead | Priorities, scope, acceptance criteria, business assumptions |
| Customer researcher | Analysis of supplied feedback, research questions, interview plan |
| Designer | User flows, interface designs, usability findings |
| Architect | Technical decisions, task boundaries, integration plan |
| Frontend engineer | Interface changes and implementation evidence |
| Backend engineer | Data, API, and integration changes |
| QA engineer | Reproductions, test results, reported defects, retest results |
| DevOps engineer | Reproducible setup, CI changes, deployment preparation |
| Documentation writer | README, onboarding instructions, examples |
| Growth and support lead | Launch drafts, support drafts, measurement plan |

Only agents with runnable work need to be active. Adding roles should improve delivery, not multiply idle conversation. Research conclusions require real customer data; launch copy and financial assumptions remain drafts until checked against evidence.

## How coordination should work

- Every task has an owner, scope, dependencies, acceptance criteria, and a deliverable.
- Messages and handoffs belong to tasks. A message to another agent triggers work only through an explicit assignment or supported wakeup mechanism.
- Concurrent code work uses isolated branches or workspaces. Shared product decisions and task status survive individual agent sessions.
- QA checks a recorded code revision. If the code changes after verification, the relevant checks run again.
- Completion includes evidence: a diff, a real test result, a preview, or a reviewable document as appropriate to the task. Failed and unrun checks remain visible.
- The founder controls publishing, external communication, and spending beyond configured limits.

Supported Claude Code and Codex sign-ins or API credentials must be available on the machine running those agents. A cloud environment does not automatically inherit a laptop login. Multiple roles share the account's usage limits. The current chat's collaboration tools do not supply a mixed Claude/GPT team.

## What would make this worth building?

[Paperclip](https://github.com/paperclipai/paperclip#readme) already provides company roles, Claude/Codex adapters, task discussions, delegation, execution workspaces, review artifacts, and persistent documents. Its founder-to-task Agent Chat is described as experimental. Those capabilities establish overlap; ten role labels alone do not distinguish our product.

Our updated improvement hypothesis is testable: a team organized around an ongoing repository mission can propose useful next work and reduce repeated founder instructions while retaining reviewable results. Paperclip already includes scheduled agent activity; continuous operation by itself is not a demonstrated differentiator.

Compare the same bounded feature on three small repositories with Paperclip's standard workflow and our proposed workflow. Record:

- Minutes from a fresh project to the first useful assigned task.
- Founder interventions needed to complete the feature, including setup, clarification, and recovery.
- Completion against acceptance criteria, alongside the percentage of coding deliveries with a reviewable diff and applicable passing checks.
- Actual time and provider usage, so reduced effort is not purchased through unbounded agent work.
- Proposal acceptance, duplicate or dismissed suggestions, and completed work tied to the original mission. These measure whether proactive behavior is useful.

Proposed success threshold: at least 30% fewer founder interventions, with no decrease in acceptance-criteria completion or verification coverage. This is a target to test, not a claimed result. If the improvement is weak, revise the workflow before expanding the team.

This prototype uses an independent implementation. Paperclip remains the comparison project for testing whether the founder workflow improves useful delivery.

## First demonstration

See [the illustrative founder workflow](FOUNDER_WORKFLOW.md) for a one-day scenario and screen behavior. Its mission and example findings are hypothetical, not results from the user's repository.

Use three active roles—product lead, engineer, and QA—on one existing application repository. Give the team an ongoing mission and let it propose a first task from actual project evidence. Show how it advances work within the given direction and surfaces any real decision for the founder, together with the conversation, changed files, QA findings if any, repairs, retests, and final delivery. Then show the next proposal and why it follows from the mission. Do not script a successful repair or display simulated activity as a live run.

After this loop works, expand the same mission into design, documentation, customer-feedback analysis, and launch preparation. That tests whether more startup roles improve an outcome instead of merely increasing the headcount.

## Decisions for the next design review

Select an existing application for the first real mission trial. Check proposal usefulness, founder direction changes, QA handoffs, retained evidence, provider usage, and recovery. Use that evidence to prioritize the next implementation rather than assuming the wider vision already works.
