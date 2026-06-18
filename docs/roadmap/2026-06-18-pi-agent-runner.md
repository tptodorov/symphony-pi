# Pi agent runner initiative

Goal: add a Pi-native worker backend for Symphony without disrupting the existing Codex app-server backend.

## Design

- Keep the current Codex backend as the default (`runner.kind: codex`).
- Add `runner.kind: pi` that spawns `pi --mode rpc` in each issue workspace.
- Communicate with Pi over its native strict JSONL RPC protocol on stdin/stdout; split only on LF and do not use Node `readline` for protocol framing.
- Start one Pi RPC process per worker attempt so each task gets workspace-local execution and isolated lifecycle management.
- Map Pi RPC events into the existing Symphony runtime event/artifact shape so the TUI, dashboard, retries, and run artifacts continue to work.

## Configuration

```yaml
runner:
  kind: pi

pi:
  command: pi --mode rpc
  model_provider: openai        # optional
  model_id: gpt-5               # optional, requires model_provider
  thinking_level: high          # optional
  turn_timeout_ms: 3600000
  read_timeout_ms: 30000
  stall_timeout_ms: 300000
```

Existing `codex:` config remains supported unchanged.

## Parity target

- Same tracker support: Linear, Jira, Beads.
- Same workspace/hook flow.
- Same concurrency, retry, reconciliation, stall timeout, and run artifacts.
- Pi-specific model and thinking-level selection.
- Dialog-style extension UI requests are cancelled for autonomous runs; fire-and-forget UI notifications are logged as runtime events.

## Implementation steps

1. Add `runner` and `pi` config parsing and validation.
2. Add `PiAppServerClient` native RPC client with fake RPC tests.
3. Switch the orchestrator to select Codex or Pi runner per config.
4. Update TUI/config summaries, README, and workflow examples.
5. Run typecheck, unit tests, and smoke where available.
