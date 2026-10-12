# Connected workspace views

The company overview, mission map, 3D office, workbench, and timeline inspect the same workspace from different perspectives.

## Follow a mission

Start with one concrete outcome, such as improving the repository's first-run documentation. Create a bounded task, choose its department and owner, and link any prerequisites. Creating a task records proposed work; provider execution requires a connected, committed, clean repository, runtime permission, and an explicit start.

The mission view groups tasks by their stage and draws their recorded prerequisite links. Select a task to inspect its owner, source, output, and handoff conditions. Delivery handoffs can let QA inspect an engineering worktree before founder acceptance; acceptance handoffs wait for accepted prerequisites.

An unresolved founder question holds its affected work. The decision view identifies direct and downstream tasks and explains which prerequisites remain. Option descriptions express the proposed direction; dependency effects are derived from recorded workflow rules, not a forecast of commercial impact.

## Inspect the work itself

The workbench exposes outputs appropriate to the task: document or campaign drafts, provider reports, command evidence, diffs, changed text files, and HTML previews. Empty or unrun work remains visible as such. A provider's successful exit is not equivalent to a passing test.

Changed-file inspection uses the retained task worktree and excludes unsafe or sensitive paths. It shows current file contents. A historical checkpoint can show captured reports and evidence, but it does not recreate historical filesystem contents.

HTML previews render recorded attachments or eligible changed HTML files inside an isolated browser frame. Inline interaction is supported; access to the parent workspace, resource fetches, nested frames, and forms is blocked. Same-frame document navigation is not fully blocked. These are self-contained HTML previews, not automatically launched development servers. The sample app is labeled illustrative inside its preview.

## Explore the office

The 3D office uses the same departments, agents, and tasks. Selecting a teammate or task focuses its work; department inspection links to the relevant work and artifacts. Task markers and dependency lines reflect recorded states. They do not establish that agents exchanged live messages.

Camera controls, reduced motion, and the keyboard directory remain available. If graphics are unavailable, use the directory and inspector to reach the same work.

## Replay recorded changes

The timeline lists saved checkpoints and their sources. Select one to inspect the mission, tasks, decisions, and outputs captured at that point. Mutation controls are disabled during replay. New current activity can arrive without replacing the checkpoint being inspected.

Return to the current workspace to resume interaction. Replay does not restore files, restart providers, or undo founder decisions. HTML attachments use their captured content; current worktree file access is unavailable during replay.

The first checkpoint is a baseline, not reconstructed prior history. Retention limits and clipped historical output are disclosed. Sample and live histories remain separate.
