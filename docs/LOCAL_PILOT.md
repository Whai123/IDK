# Run the first real mission locally

The cloud prototype has not completed a real AI mission. This launcher lets you attempt the same bounded trial on a writable Mac, Linux computer, or server. It runs **Refresh provider status** with a Codex engineering role, then a separate Codex QA role in the delivered worktree. You review both outputs afterward.

Use Node.js 22.18 or newer, Git, and a native Codex CLI signed in on that computer. Codex storage, the repository's Git storage, and temporary directories must be writable. A signed-in status and writable directories are readiness checks; they do not prove native runtime initialization or provider connectivity. The previous cloud trial failed those later steps despite reporting a signed-in account.

## Prepare the computer

If you do not already have this repository:

```sh
git clone https://github.com/Whai123/IDK.git
cd IDK
```

Install the locked dependencies and build the workspace:

```sh
npm ci --cache .cache/npm --no-audit --no-fund
npm run build
```

If Codex is not installed, install the native CLI, then sign in interactively on your computer:

```sh
npm install -g @openai/codex
codex login
```

Use the supported interactive sign-in. Do not paste account tokens or credential files into this app or chat. Claude is not required for this trial.

## Check first, then explicitly run

```sh
npm run pilot
```

The default command checks Git, writable storage, native CLI installation, and sanitized authentication status. **It never sends a model prompt, enables native execution, or starts work.** Resolve any blocked checks. Your checkout must contain a commit and be clean; the launcher never commits or discards your changes.

When ready to spend Codex account quota on this one mission:

```sh
npm run pilot -- --run
```

The terminal prints a local URL on a free port. Open it in a browser on the same computer to see the clearly labelled read-only evidence viewer. Existing development servers and saved company state are left alone. The pilot stores a new workspace under `.startup-os/local-pilot/run-*`; that directory is ignored by Git.

The Engineering role implements a Settings action that refreshes native provider status without restarting or starting an AI job. The engine then creates an independent QA handoff using the same retained worktree. Only those two native jobs are permitted. The recorded setup direction permits `npm ci` for the exact existing lockfile inside that worktree; it does not authorize new dependencies or global tools.

The launcher stops the mission when both outputs await review, either role needs founder direction, a job fails, or the trial reaches its 25-minute limit. Each native job has a 10-minute bound. Native execution is disabled after the attempt, and neither output is accepted. The viewer stays open until you press Ctrl+C. Ctrl+C during a job interrupts native execution and retains the available work and evidence.

## Review what actually happened

The viewer shows recorded task status, provider output, check evidence, open direction requests, and retained worktree paths. `pilot-result.json` in the printed state directory contains the outcome and paths. A `ready_for_review` outcome means both provider outputs are ready to inspect; it is not a claim that QA passed. Read the actual recorded commands, exit codes, limitations, and diff before deciding whether the change is useful.

The launcher never accepts, commits, merges, pushes, publishes, or deploys the deliverables. Worktrees are retained in the operating system's temporary directory, so copy useful work before that computer cleans temporary files.

After stopping the pilot, you can open its persisted state in the built full workspace. Replace the example directory with the one printed in your terminal:

```sh
STARTUP_STATE_DIR=.startup-os/local-pilot/run-YOUR_DIRECTORY npm start
```

Native execution remains off and the team remains paused. That full workspace supports founder review and direction, so take deliberate action before enabling more work. If its default port is occupied, also set `STARTUP_PORT` to a free local port. No real local mission has been run or proven merely by adding this launcher.
