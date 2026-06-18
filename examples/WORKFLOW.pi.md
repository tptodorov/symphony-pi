---
tracker:
  kind: beads
  command: bd
  ready_command: bd ready --json
  active_states: [open, in_progress]
  terminal_states: [closed]

runner:
  kind: pi

workspace:
  root: .symphony/workspaces

agent:
  max_concurrent_agents: 1
  max_turns: 3

pi:
  command: pi --mode rpc
  # Optional model override. If omitted, Pi uses Pi's default selection.
  # model_provider: openai
  # model_id: gpt-5
  # thinking_level: high
  turn_timeout_ms: 3600000
  read_timeout_ms: 30000
  stall_timeout_ms: 300000
---
You are a Pi agent worker for Beads task {{ issue.identifier }}: {{ issue.title }}.

Task details:
{{ issue.description }}

Use the repository's Pi tools, skills, and instructions. Keep changes focused, run relevant checks, and summarize what changed before finishing.
