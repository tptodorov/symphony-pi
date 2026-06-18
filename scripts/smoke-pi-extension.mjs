#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const helper = {
	rpc: async (proc, stdoutLines, message) => {
		proc.stdin.write(`${JSON.stringify(message)}\n`);
		return await helper.waitForLine(stdoutLines, (parsed) => parsed.type === "response" && parsed.id === message.id, 10_000);
	},
	waitForLine: async (stdoutLines, predicate, timeoutMs) => {
		const deadline = Date.now() + timeoutMs;
		let cursor = 0;
		while (Date.now() < deadline) {
			while (cursor < stdoutLines.length) {
				const raw = stdoutLines[cursor++];
				try {
					const parsed = JSON.parse(raw);
					if (predicate(parsed)) {
						if (parsed.success === false) throw new Error(`RPC command failed: ${parsed.error ?? raw}`);
						return parsed;
					}
				} catch (error) {
					if (error instanceof SyntaxError) continue;
					throw error;
				}
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		throw new Error(`timed out waiting for pi RPC line. Seen stdout=${stdoutLines.join("\n").slice(-4000)}`);
	},
};

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pi = process.env.PI_BIN ?? "pi";

if (spawnSync(pi, ["--version"], { encoding: "utf8" }).error) {
	console.log(`[skip] pi binary not found (${pi}); install pi or set PI_BIN to run this smoke.`);
	process.exit(0);
}

const consumer = await mkdtemp(join(tmpdir(), "pi-symphony-pi-smoke-"));
const sessionDir = await mkdtemp(join(tmpdir(), "pi-symphony-pi-session-"));
const agentDir = await mkdtemp(join(tmpdir(), "pi-symphony-pi-agent-"));
let proc;
try {
	await writeFile(
		join(consumer, "WORKFLOW.md"),
		`---
tracker:
  kind: beads
codex:
  command: echo fake-codex-app-server
workspace:
  root: ./workspaces
---
Smoke prompt for {{ issue.identifier }}.
`,
		"utf8",
	);

	proc = spawn(
		pi,
		[
			"--mode",
			"rpc",
			"--offline",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			"--no-session",
			"--extension",
			projectRoot,
		],
		{
			cwd: consumer,
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: agentDir,
				PI_CODING_AGENT_SESSION_DIR: sessionDir,
				PI_OFFLINE: "1",
			},
			stdio: ["pipe", "pipe", "pipe"],
		},
	);

	const stdoutLines = [];
	const stderrChunks = [];
	proc.stdout.setEncoding("utf8");
	proc.stderr.setEncoding("utf8");
	proc.stdout.on("data", (chunk) => {
		for (const line of chunk.split("\n")) {
			if (line.trim()) stdoutLines.push(line.trim());
		}
	});
	proc.stderr.on("data", (chunk) => stderrChunks.push(chunk));

	const commands = await helper.rpc(proc, stdoutLines, { id: "commands", type: "get_commands" });
	const commandNames = commands.data?.commands?.map((command) => command.name) ?? [];
	if (!commandNames.includes("symphony")) throw new Error("missing registered command: symphony");
	for (const removed of ["symphony:validate", "symphony:once", "symphony:daemon", "symphony:panel", "symphony:stop", "symphony:status"]) {
		if (commandNames.includes(removed)) throw new Error(`legacy command still registered: ${removed}`);
	}

	console.log(`[ok] pi loaded package from ${projectRoot} and registered single /symphony command in ${consumer}`);
} finally {
	if (proc && !proc.killed) proc.kill("SIGTERM");
	await rm(consumer, { recursive: true, force: true });
	await rm(sessionDir, { recursive: true, force: true });
	await rm(agentDir, { recursive: true, force: true });
}
