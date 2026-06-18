#!/usr/bin/env node
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { main } from "../src/cli.js";

const bd = process.env.BD_BIN ?? "bd";
if (spawnSync(bd, ["--version"], { encoding: "utf8" }).error) {
	console.log(`[skip] bd binary not found (${bd}); install Beads or set BD_BIN to run this smoke.`);
	process.exit(0);
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fakeCodex = join(projectRoot, "scripts", "fake-codex-app-server.cjs");
const fakePi = join(projectRoot, "scripts", "fake-pi-app-server.cjs");
const runnerKind = process.env.PI_SYMPHONY_E2E_RUNNER === "pi" ? "pi" : "codex";
const cwd = await mkdtemp(join(tmpdir(), "pi-symphony-beads-e2e-"));
const oldCwd = process.cwd();
try {
	run(bd, ["init", "--non-interactive", "--skip-agents", "--skip-hooks", "--prefix", "smoke"], cwd);
	const created = run(bd, ["create", "Smoke issue for pi-symphony", "--type", "task", "--priority", "P1", "--description", "Safe test issue for pi-symphony Beads smoke.", "--json"], cwd);
	const issue = JSON.parse(created.stdout)[0] ?? JSON.parse(created.stdout);
	const issueId = issue.id;
	if (!issueId) throw new Error(`bd create did not return an issue id: ${created.stdout}`);

	await writeFile(
		join(cwd, "WORKFLOW.md"),
		`---
tracker:
  kind: beads
  command: ${bd}
  ready_command: ${bd} ready --json
  active_states: [open, in_progress]
  terminal_states: [closed]
workspace:
  root: ./workspaces
agent:
  max_turns: 1
runner:
  kind: ${runnerKind}
codex:
  command: node ${shellQuote(fakeCodex)}
  read_timeout_ms: 1000
  turn_timeout_ms: 1000
pi:
  command: node ${shellQuote(fakePi)}
  read_timeout_ms: 1000
  turn_timeout_ms: 1000
---
Handle {{ issue.identifier }}: {{ issue.title }}.
`,
		"utf8",
	);

	process.chdir(cwd);
	const exitCode = await main(["--once", issueId]);
	if (exitCode !== 0) throw new Error(`pi-symphony --once exited ${exitCode}`);
	const workspace = join(cwd, "workspaces", issueId);
	if (!existsSync(workspace)) throw new Error(`expected workspace to be created: ${workspace}`);
	const workflow = await readFile(join(cwd, "WORKFLOW.md"), "utf8");
	if (!workflow.includes("kind: beads")) throw new Error("temporary workflow did not use Beads tracker");
	console.log(`[ok] Beads E2E smoke fetched ${issueId}, ran fake ${runnerKind} runner, and created ${workspace}`);
} finally {
	process.chdir(oldCwd);
	await rm(cwd, { recursive: true, force: true });
}

function run(command: string, args: string[], cwd: string): SpawnSyncReturns<string> {
	const result = spawnSync(command, args, { cwd, encoding: "utf8", env: { ...process.env, BD_NON_INTERACTIVE: "1" } });
	if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
	return result;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}
