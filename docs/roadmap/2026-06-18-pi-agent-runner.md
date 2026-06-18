# Pi agent runner initiative

Goal: add a Pi-native worker backend for Symphony without disrupting the existing Codex app-server backend.

## Design

- Keep the current Codex backend as the default (`runner.kind: codex`).
- Add `runner.kind: pi` that talks to `pi-app-server` over stdio.
- Do not add `pi-app-server` as an npm dependency. The Pi runner launches a configurable command, defaulting to `npx --yes --package pi-app-server@2.0.0 pi-server`, and speaks the published JSON protocol directly.
- Start one `pi-server` process per worker attempt. Each process gets an ephemeral WebSocket port via `PI_SERVER_PORT` so concurrent workers do not collide while Symphony uses stdio only.
- Map Pi session events into the existing Symphony runtime event/artifact shape so the TUI, dashboard, retries, and run artifacts continue to work.

## Configuration

```yaml
runner:
  kind: pi

pi:
  command: npx --yes --package pi-app-server@2.0.0 pi-server
  model_provider: openai        # optional
  model_id: gpt-5               # optional, requires model_provider
  thinking_level: high          # optional
  turn_timeout_ms: 3600000
  read_timeout_ms: 5000
  stall_timeout_ms: 300000
```

Existing `codex:` config remains supported unchanged.

## Parity target

- Same tracker support: Linear, Jira, Beads.
- Same workspace/hook flow.
- Same concurrency, retry, reconciliation, stall timeout, and run artifacts.
- Pi-specific model and thinking-level selection.
- Interactive extension UI requests are cancelled and treated as `user_input_required` for autonomous runs.

Known difference: `pi-app-server` 2.0.0 has its own command timeout in the server process. Symphony still enforces `pi.turn_timeout_ms`, but very long prompts can also be bounded by the server's internal timeout.

## Implementation steps

1. Add `runner` and `pi` config parsing and validation.
2. Add `PiAppServerClient` stdio protocol client with fake-server tests.
3. Switch the orchestrator to select Codex or Pi runner per config.
4. Update TUI/config summaries, README, and workflow examples.
5. Run typecheck, unit tests, and smoke where available.
