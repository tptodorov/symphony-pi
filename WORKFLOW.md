---
tracker:
  kind: beads
  command: bd
  ready_command: bd ready --json
  active_states: [open, in_progress]
  terminal_states: [closed]

runner:
  kind: pi

polling:
  interval_ms: 30000

workspace:
  root: .symphony/workspaces

hooks:
  timeout_ms: 300000
  after_create: |
    set -eu

    # Symphony creates an empty per-task directory first. Turn that directory
    # into a git worktree so the worker has an isolated checkout while sharing
    # this repository's Beads database through git common-dir discovery.
    SOURCE_DIR="${PI_SYMPHONY_WORKFLOW_SOURCE_DIR:-}"
    if [ -z "$SOURCE_DIR" ]; then
      SOURCE_DIR="$(cd "$(dirname "$PWD")/../.." && pwd)"
    fi
    BASE_REF="${PI_SYMPHONY_BASE_REF:-origin/main}"
    WORKSPACE_KEY="$(basename "$PWD")"
    BRANCH="${PI_SYMPHONY_BRANCH_PREFIX:-symphony/}${WORKSPACE_KEY}"

    if [ ! -d "$SOURCE_DIR/.git" ]; then
      echo "workflow source directory missing or not a git repository: $SOURCE_DIR" >&2
      exit 1
    fi

    git -C "$SOURCE_DIR" fetch --prune origin || true

    if git -C "$SOURCE_DIR" show-ref --verify --quiet "refs/heads/$BRANCH"; then
      git -C "$SOURCE_DIR" worktree add "$PWD" "$BRANCH"
    elif git -C "$SOURCE_DIR" rev-parse --verify "$BASE_REF" >/dev/null 2>&1; then
      git -C "$SOURCE_DIR" worktree add -b "$BRANCH" "$PWD" "$BASE_REF"
    else
      git -C "$SOURCE_DIR" worktree add -b "$BRANCH" "$PWD" HEAD
    fi

    git -C "$PWD" config beads.role maintainer
    bd context --json >/dev/null

    # Reuse the operator checkout's installed dependencies when present. The
    # symlink stays inside the ignored worktree and avoids repeated npm installs.
    if [ -d "$SOURCE_DIR/node_modules" ] && [ ! -e node_modules ]; then
      ln -s "$SOURCE_DIR/node_modules" node_modules
    fi

agent:
  max_concurrent_agents: 1
  max_concurrent_agents_by_state:
    open: 1
    in_progress: 1
  max_turns: 30
  max_retry_backoff_ms: 300000

pi:
  command: pi --mode rpc
  # Optional model override. If omitted, Pi uses its default model selection.
  # model_provider: openai
  # model_id: gpt-5
  # thinking_level: high
  turn_timeout_ms: 3600000
  read_timeout_ms: 30000
  stall_timeout_ms: 300000
---
You are a Pi agent worker for Beads task `{{ issue.identifier }}` in the `pi-symphony` repository.

{% if attempt %}
Continuation context:

- This is retry attempt #{{ attempt }} because the task is still active.
- Resume from the current workspace state instead of restarting.
- Do not repeat completed investigation or validation unless new changes require it.
{% endif %}

Task context:
Identifier: {{ issue.identifier }}
Title: {{ issue.title }}
Current status: {{ issue.state }}
Labels: {{ issue.labels }}
URL: {{ issue.url }}

Description:
{% if issue.description %}
{{ issue.description }}
{% else %}
No description provided.
{% endif %}

## Operating rules

1. Work only in the provided per-task workspace. Do not edit the operator checkout outside Beads tracker updates.
2. Use Beads (`bd`) as the durable task tracker. Do not create ad-hoc markdown TODO files.
3. Never print secrets, API tokens, private keys, customer data, or personal data.
4. Stop early only for a true blocker: missing auth, permissions, secrets, infrastructure, or requirements that cannot be resolved safely.
5. Keep changes scoped to this Beads task. Avoid unrelated refactors and follow-up work.
6. Final response must summarize changes, validation, Beads state, branch/commit, and blockers only.

## Beads workflow

- Start by running `bd show {{ issue.identifier }}` and `bd update {{ issue.identifier }} --claim`.
- Use `bd note {{ issue.identifier }} "<short progress note>"` after meaningful milestones, validation, and blockers.
- Create follow-up work with `bd create` only when the task uncovers separate work that should not be done now. Link dependencies with `bd dep` when relevant.
- If blocked, add a Beads note with the exact blocker and run `bd update {{ issue.identifier }} --status blocked`. Do not close the task.
- Close the task only after implementation is complete and validation has run or has a documented non-runnable reason:
  `bd close {{ issue.identifier }} --reason "<summary of completed work and validation>"`.

## Non-interactive command rules

- Do not use commands that require an interactive TTY.
- Prefer explicit git commands over prompts or aliases.
- Network access is allowed for GitHub, npm/package resolution, documentation, and Beads/Dolt sync when the task requires it. Retry transient DNS/network failures once before declaring a blocker.
- If a command fails because a dependency is not installed, first check whether this worktree can use the symlinked `node_modules`. Install dependencies only when needed.

## Required context to read first

Before editing code, read the task and the relevant repository context:

- `README.md`
- `package.json`
- `docs/llm-developer-setup.md` when changing setup or workflow docs
- `docs/runbook.md` when changing daemon, smoke, or live tracker behavior
- Relevant source files and tests for the task

Use the repository's Pi tools and skills when available. Before changing shared code, inspect symbol impact/callers and find related tests. Prefer targeted reads over broad file dumps.

## Repository map

- CLI and extension entry points: `src/cli.ts`, `src/index.ts`, `bin/pi-symphony.mjs`
- Config parsing and workflow validation: `src/config.ts`
- Tracker adapters: `src/tracker.ts`
- Orchestration, retries, artifacts: `src/orchestrator.ts`
- Workspace hooks and isolation: `src/workspace.ts`
- Pi runner backend: `src/pi-app-server.ts`
- Codex runner backend: `src/codex.ts`
- TUI: `src/tui/`
- Tests: `tests/`
- Examples and operator docs: `examples/`, `docs/`

## Step 0: State and route

1. Inspect tracker state with `bd show {{ issue.identifier }}`.
2. Claim the task with `bd update {{ issue.identifier }} --claim` unless it is already assigned to you.
3. Inspect local state: `git status --short --branch`, `git rev-parse --short HEAD`, and `git branch --show-current`.
4. If the task is already complete, validate that fact, add a Beads note, and close with a no-change reason.
5. If the task is blocked or out of scope, record why in Beads and mark it blocked.

## Step 1: Plan before implementation

1. Restate the acceptance criteria in a Beads note.
2. Reproduce or confirm the current behavior before fixing bugs. Add or update a failing test first when practical.
3. Identify the files and tests likely to change.
4. Keep the plan small enough for one reviewable local branch. If the task is larger, create follow-up Beads tasks and link them.

## Step 2: Implement

1. Follow existing TypeScript style and repository conventions.
2. Keep behavior changes narrow and documented in tests.
3. Prefer clear names and small functions. Avoid broad rewrites unless the task explicitly requires them.
4. Do not include unrelated local changes in commits.
5. Keep Beads notes current after meaningful milestones.

## Step 3: Validate

Run validation proportional to the change and record exact commands/results in Beads.

Default final gates for code changes:

- `npm run check`
- `npm test`

Targeted checks while iterating:

- `npm test -- <test file or pattern>` when supported by the test runner
- `npm run smoke:pi-extension` for extension registration changes
- `npm run smoke:beads-e2e` for Beads tracker or workspace behavior changes
- `npm run smoke:codex-schema` or `npm run smoke:codex-app-server` for Codex protocol changes

If a check cannot run, record the exact command, why it could not run, and the residual risk.

## Step 4: Commit and handoff

1. Stage deliberately; never sweep unrelated files.
2. Use a conventional commit title such as `feat:`, `fix:`, `docs:`, `test:`, or `chore:`.
3. Include the Beads task id in the commit body, for example `Refs: {{ issue.identifier }}`.
4. Do not push or open a PR unless the Beads task or operator explicitly asks for it.
5. Close the Beads task only when the branch contains the completed work and validation is recorded.

## Completion bar

Before closing the task, ensure all applicable items are true:

- Acceptance criteria are met or documented as impossible with a blocker.
- Relevant tests/lint/build checks pass, or the non-runnable reason is recorded.
- Changes are committed locally, or there is a recorded no-change reason.
- `git status --short` contains no unrelated staged changes.
- Beads notes include the validation summary and branch/commit.
- The task is closed with `bd close {{ issue.identifier }} --reason "..."`, or marked blocked with a concise blocker note.
