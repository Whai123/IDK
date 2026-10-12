# Founder workflow — illustrative design

The application, findings, times, and founder dialogue below are hypothetical. The workspace prototype is implemented in this repository; this scenario describes the broader trial to perform next. See [the README](../README.md) for implemented capabilities and their limits. No application has yet been selected for a real provider-driven mission trial.

## Mission and home screen

Example mission: “Make this application easier to try. Keep the existing quickstart working and improve onboarding. Ask me when product direction is needed.”

The founder home keeps the mission visible and links to four work views:

| View | What the founder sees | Available interaction |
| --- | --- | --- |
| Needs your direction | A decision, supporting evidence, options, recommendation, and affected work | Answer, ask a follow-up, or defer |
| In progress | Task owner, goal, current state, last real activity, and dependencies | Open work, redirect, or pause |
| Delivered with evidence | Artifact, verification, unresolved limitations, and linked mission | Inspect, accept, or request changes |
| Proposed next | Why the task matters now, evidence, scope, effort, and success criteria | Prioritize, defer, dismiss, or give direction |

Conversations open from the associated task or decision. The home summarizes progress; the details explain what actually happened.

## A day with the team

**09:00 — The team finds useful work.** QA attempts the documented quickstart on a fresh supported environment and records a failure. The product lead creates a bounded repair task linked to the mission and reproduction. Repairing the existing instructions follows the direction already given.

**10:00 — Work moves between roles.** An engineer repairs the startup instructions and a documentation agent reviews the remaining guide. QA prepares a clean rerun. Each handoff records the output and what the next owner must check. The founder can inspect the evidence without being asked to coordinate routine handoffs.

**11:00 — A direction question appears.** The product lead proposes a browser-based trial as a possible next step. This introduces a product and hosting choice, so it stays a proposal. The decision card asks: “Should we focus on developers running the repo, or people trying it in a browser?” It explains the effort and tradeoffs and recommends strengthening the existing quickstart first. It also identifies the repair and independent guide review that can continue while waiting. There is no inferred answer if the founder is away.

**12:00 — The founder changes priorities.** Example answer: “Focus on developers first. Put a runnable example ahead of screenshot polish; defer the browser trial.” The team stores that direction and shows the revised plan: keep the startup repair, defer browser-trial planning, hold screenshot polish, preserve its draft, and assess the example against the new priority. Work affected by the change picks up the new decision before continuing.

**13:00 — Delivery includes proof.** QA reruns the quickstart on the recorded repaired revision. The delivery contains the instructions diff, actual command results, and any remaining problems. If the code or instructions change after verification, the delivery's verification status is updated and relevant checks run again. “Agent says done” is not the completion criterion.

**Later — The next proposal reflects the answer.** The guide review may identify that users can start the application but lack an example of completing its main workflow. If the evidence supports it, the team proposes a runnable example with a concrete success criterion. Browser-trial work remains deferred; it does not reappear simply because another agent suggested it.

**When no useful task can proceed — Show that clearly.** Display a scheduled review or the specific decision or prerequisite being awaited. Persist the mission, decisions, work, and evidence so the team can resume when an event or answer arrives. Continuous responsibility includes tracking and resumption; it does not require agents to generate activity constantly.

## What this example must demonstrate in a real trial

- A useful task is discovered from actual evidence and linked to the founder's mission.
- Routine work proceeds within established direction; a genuine product choice reaches the founder with options and a recommendation.
- Independent work continues while the decision is pending.
- A changed priority updates affected assignments and preserves unfinished useful work.
- Delivery verification refers to the actual delivered revision; failed and unrun checks remain visible.
- The next proposal reflects the founder's decision and previous outcomes.
- The founder can distinguish active work, waiting work, scheduled reviews, and interrupted execution.

This trial establishes workflow behavior. Separate comparison with Paperclip is needed to judge whether the experience reduces founder effort or improves useful delivery.
