import { access, readFile, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { parseDocument } from "yaml";

import { SymphonyConfigError, type RunnerKind, type SymphonyConfig, type TrackerKind, type WorkflowDefinition } from "./types.js";

export const DEFAULT_WORKFLOW_FILE = "WORKFLOW.md";
export const DEFAULT_PROMPT = "You are working on an issue from Linear.";

export interface SymphonyConfigProbe {
	cwd: string;
	workflowPath: string;
	workflowExists: boolean;
	workflowBytes?: number;
	valid?: boolean;
	error?: { code: string; message: string };
}

export async function probeConfig(cwd: string, explicitWorkflowPath?: string): Promise<SymphonyConfigProbe> {
	const workflowPath = resolveWorkflowPath(cwd, explicitWorkflowPath);
	try {
		const stats = await stat(workflowPath);
		try {
			await loadResolvedConfig(cwd, explicitWorkflowPath);
			return { cwd, workflowPath, workflowExists: true, workflowBytes: stats.size, valid: true };
		} catch (error) {
			return {
				cwd,
				workflowPath,
				workflowExists: true,
				workflowBytes: stats.size,
				valid: false,
				error: normalizeError(error),
			};
		}
	} catch {
		return { cwd, workflowPath, workflowExists: false, valid: false, error: { code: "missing_workflow_file", message: `Missing workflow file: ${workflowPath}` } };
	}
}

export function resolveWorkflowPath(cwd: string, explicitWorkflowPath?: string): string {
	if (explicitWorkflowPath?.trim()) return resolve(cwd, explicitWorkflowPath.trim());
	return resolve(cwd, DEFAULT_WORKFLOW_FILE);
}

export async function loadWorkflow(cwd: string, explicitWorkflowPath?: string): Promise<WorkflowDefinition> {
	const workflowPath = resolveWorkflowPath(cwd, explicitWorkflowPath);
	let content: string;
	try {
		content = await readFile(workflowPath, "utf8");
	} catch {
		throw new SymphonyConfigError("missing_workflow_file", `Missing workflow file: ${workflowPath}`);
	}

	const { frontMatter, body } = splitFrontMatter(content);
	let config: Record<string, unknown> = {};
	if (frontMatter !== null) {
		try {
			const doc = parseDocument(frontMatter, { prettyErrors: false });
			if (doc.errors.length > 0) {
				throw doc.errors[0];
			}
			const parsed = doc.toJSON();
			if (parsed === null) config = {};
			else if (!isPlainObject(parsed)) {
				throw new SymphonyConfigError("workflow_front_matter_not_a_map", "WORKFLOW.md front matter must decode to an object/map");
			} else config = parsed as Record<string, unknown>;
		} catch (error) {
			if (error instanceof SymphonyConfigError) throw error;
			throw new SymphonyConfigError("workflow_parse_error", `Failed to parse WORKFLOW.md front matter: ${errorMessage(error)}`);
		}
	}

	return { path: workflowPath, config, prompt_template: body.trim() };
}

export async function loadResolvedConfig(cwd: string, explicitWorkflowPath?: string): Promise<{ workflow: WorkflowDefinition; config: SymphonyConfig }> {
	const workflow = await loadWorkflow(cwd, explicitWorkflowPath);
	const workflowDir = dirname(workflow.path);
	const dotenv = await loadDotEnv(workflowDir);
	return { workflow, config: resolveConfig(workflow, { ...dotenv, ...process.env }) };
}

export function resolveConfig(workflow: WorkflowDefinition, env: NodeJS.ProcessEnv = process.env): SymphonyConfig {
	const root = workflow.config;
	const workflowDir = dirname(workflow.path);
	const tracker = objectAt(root, "tracker");
	const polling = objectAt(root, "polling");
	const workspace = objectAt(root, "workspace");
	const hooks = objectAt(root, "hooks");
	const agent = objectAt(root, "agent");
	const runner = objectAt(root, "runner");
	const codex = objectAt(root, "codex");
	const pi = objectAt(root, "pi");
	const server = objectAt(root, "server");

	if (!hasOwn(tracker, "kind")) {
		throw new SymphonyConfigError("missing_tracker_kind", "tracker.kind is required; use kind: linear for OpenAI Symphony dispatch, or explicitly select jira/beads extensions");
	}
	const trackerKindRaw = stringAt(tracker, "kind", "");
	if (!["linear", "jira", "beads"].includes(trackerKindRaw)) {
		throw new SymphonyConfigError("unsupported_tracker_kind", `Unsupported tracker.kind: ${trackerKindRaw}`);
	}
	const trackerKind = trackerKindRaw as TrackerKind;

	const runnerKindRaw = stringAt(runner, "kind", "codex");
	if (!["codex", "pi"].includes(runnerKindRaw)) {
		throw new SymphonyConfigError("unsupported_runner_kind", `Unsupported runner.kind: ${runnerKindRaw}`);
	}
	const runnerKind = runnerKindRaw as RunnerKind;

	const apiKeyValue = stringAt(tracker, "api_key", trackerKind === "linear" ? "$LINEAR_API_KEY" : "");
	const apiKey = resolveDollar(apiKeyValue, env);
	const projectSlug = resolveDollar(stringAt(tracker, "project_slug", ""), env);
	const jiraEmail = resolveDollar(stringAt(tracker, "email", "$JIRA_EMAIL"), env);
	const jiraApiToken = resolveDollar(stringAt(tracker, "api_token", "$JIRA_API_TOKEN"), env);
	const jiraProjectKey = resolveDollar(stringAt(tracker, "project_key", projectSlug), env);
	const jiraJql = nullableStringAt(tracker, "jql");
	const beadsCommand = stringAt(tracker, "command", "bd");
	const beadsReadyCommand = stringAt(tracker, "ready_command", `${beadsCommand} ready --json`);

	const activeStates = stringArrayAt(tracker, "active_states", trackerKind === "beads" ? ["open", "in_progress"] : ["Todo", "In Progress"]);
	const terminalStates = stringArrayAt(tracker, "terminal_states", trackerKind === "beads" ? ["closed"] : ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"]);

	const maxConcurrentByState: Record<string, number> = {};
	const perStateRaw = objectAt(agent, "max_concurrent_agents_by_state");
	for (const [state, value] of Object.entries(perStateRaw)) {
		const n = asInteger(value, NaN);
		if (Number.isFinite(n) && n > 0) maxConcurrentByState[normalizeState(state)] = n;
	}

	const workspaceRootRaw = stringAt(workspace, "root", resolve(tmpdir(), "symphony_workspaces"));
	const workspaceRoot = resolvePathValue(workspaceRootRaw, workflowDir, env);

	const pollIntervalMs = positiveIntegerAt(polling, "interval_ms", 30_000, "polling.interval_ms");
	const hookTimeoutMs = positiveIntegerAt(hooks, "timeout_ms", 60_000, "hooks.timeout_ms");
	const maxTurns = positiveIntegerAt(agent, "max_turns", 20, "agent.max_turns");
	const maxAgents = positiveIntegerAt(agent, "max_concurrent_agents", 10, "agent.max_concurrent_agents");
	const maxRetryBackoffMs = positiveIntegerAt(agent, "max_retry_backoff_ms", 300_000, "agent.max_retry_backoff_ms");
	const turnTimeoutMs = positiveIntegerAt(codex, "turn_timeout_ms", 3_600_000, "codex.turn_timeout_ms");
	const readTimeoutMs = positiveIntegerAt(codex, "read_timeout_ms", 5_000, "codex.read_timeout_ms");
	const stallTimeoutMs = integerConfigAt(codex, "stall_timeout_ms", 300_000, "codex.stall_timeout_ms");
	const piTurnTimeoutMs = positiveIntegerAt(pi, "turn_timeout_ms", 3_600_000, "pi.turn_timeout_ms");
	const piReadTimeoutMs = positiveIntegerAt(pi, "read_timeout_ms", 30_000, "pi.read_timeout_ms");
	const piStallTimeoutMs = integerConfigAt(pi, "stall_timeout_ms", 300_000, "pi.stall_timeout_ms");
	const serverPort = optionalPortAt(server, "port", "server.port");
	const codexCommand = stringAt(codex, "command", "codex app-server");
	const piCommand = stringAt(pi, "command", "pi --mode rpc");

	return {
		workflowPath: workflow.path,
		workflowDir,
		tracker: {
			kind: trackerKind,
			endpoint: resolveDollar(stringAt(tracker, "endpoint", trackerKind === "jira" ? "" : "https://api.linear.app/graphql"), env),
			apiKey: apiKey || null,
			projectSlug,
			jiraEmail: jiraEmail || null,
			jiraApiToken: jiraApiToken || null,
			jiraProjectKey,
			jiraJql,
			jiraPageSize: optionalIntegerAt(tracker, "page_size"),
			beadsCommand,
			beadsReadyCommand,
			activeStates,
			terminalStates,
		},
		polling: { intervalMs: pollIntervalMs },
		workspace: { root: workspaceRoot },
		hooks: {
			afterCreate: nullableStringAt(hooks, "after_create"),
			beforeRun: nullableStringAt(hooks, "before_run"),
			afterRun: nullableStringAt(hooks, "after_run"),
			beforeRemove: nullableStringAt(hooks, "before_remove"),
			timeoutMs: hookTimeoutMs,
		},
		agent: {
			maxConcurrentAgents: maxAgents,
			maxTurns,
			maxRetryBackoffMs,
			maxConcurrentAgentsByState: maxConcurrentByState,
		},
		runner: { kind: runnerKind },
		codex: {
			command: codexCommand,
			approvalPolicy: codex.approval_policy,
			threadSandbox: codex.thread_sandbox,
			turnSandboxPolicy: codex.turn_sandbox_policy,
			turnTimeoutMs,
			readTimeoutMs,
			stallTimeoutMs,
		},
		pi: {
			command: piCommand,
			modelProvider: nullableStringAt(pi, "model_provider"),
			modelId: nullableStringAt(pi, "model_id"),
			thinkingLevel: nullableStringAt(pi, "thinking_level"),
			turnTimeoutMs: piTurnTimeoutMs,
			readTimeoutMs: piReadTimeoutMs,
			stallTimeoutMs: piStallTimeoutMs,
		},
		server: { port: serverPort },
	};
}

export function validateDispatchConfig(config: SymphonyConfig): void {
	if (config.tracker.kind === "linear") {
		if (!config.tracker.apiKey) throw new SymphonyConfigError("missing_tracker_api_key", "tracker.api_key is missing after environment resolution");
		if (!config.tracker.projectSlug) throw new SymphonyConfigError("missing_tracker_project_slug", "tracker.project_slug is required for Linear dispatch");
	} else if (config.tracker.kind === "jira") {
		if (!config.tracker.endpoint) throw new SymphonyConfigError("invalid_config", "tracker.endpoint is required for Jira Cloud");
		if (!config.tracker.jiraEmail) throw new SymphonyConfigError("missing_jira_email", "tracker.email is missing after environment resolution");
		if (!config.tracker.jiraApiToken) throw new SymphonyConfigError("missing_jira_api_token", "tracker.api_token is missing after environment resolution");
		if (!config.tracker.jiraProjectKey && !config.tracker.jiraJql) throw new SymphonyConfigError("missing_jira_project_key", "tracker.project_key or tracker.jql is required for Jira Cloud");
	} else if (config.tracker.kind !== "beads") {
		throw new SymphonyConfigError("unsupported_tracker_kind", `Unsupported tracker.kind: ${config.tracker.kind}`);
	}
	if (config.runner.kind === "codex" && !config.codex.command.trim()) throw new SymphonyConfigError("missing_codex_command", "codex.command must be present and non-empty");
	if (config.runner.kind === "pi" && !config.pi.command.trim()) throw new SymphonyConfigError("missing_pi_command", "pi.command must be present and non-empty");
}

export async function assertExplicitWorkflowExists(cwd: string, explicitWorkflowPath?: string): Promise<void> {
	const workflowPath = resolveWorkflowPath(cwd, explicitWorkflowPath);
	try {
		await access(workflowPath);
	} catch {
		throw new SymphonyConfigError("missing_workflow_file", `Missing workflow file: ${workflowPath}`);
	}
}

function splitFrontMatter(content: string): { frontMatter: string | null; body: string } {
	const normalized = content.replace(/^\uFEFF/, "");
	if (!normalized.startsWith("---")) return { frontMatter: null, body: normalized };
	const lines = normalized.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return { frontMatter: null, body: normalized };
	for (let i = 1; i < lines.length; i++) {
		if (lines[i]?.trim() === "---") {
			return { frontMatter: lines.slice(1, i).join("\n"), body: lines.slice(i + 1).join("\n") };
		}
	}
	throw new SymphonyConfigError("workflow_parse_error", "WORKFLOW.md starts front matter with --- but never closes it");
}

function objectAt(root: Record<string, unknown>, key: string): Record<string, unknown> {
	const value = root[key];
	return isPlainObject(value) ? (value as Record<string, unknown>) : {};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(root: Record<string, unknown>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(root, key);
}

function stringAt(root: Record<string, unknown>, key: string, fallback: string): string {
	const value = root[key];
	return typeof value === "string" ? value : fallback;
}

function nullableStringAt(root: Record<string, unknown>, key: string): string | null {
	const value = root[key];
	return typeof value === "string" && value.length > 0 ? value : null;
}

function stringArrayAt(root: Record<string, unknown>, key: string, fallback: string[]): string[] {
	const value = root[key];
	if (!Array.isArray(value)) return fallback;
	const strings = value.filter((item): item is string => typeof item === "string");
	return strings.length > 0 ? strings : fallback;
}

function integerConfigAt(root: Record<string, unknown>, key: string, fallback: number, label: string): number {
	if (!(key in root)) return fallback;
	const value = asInteger(root[key], NaN);
	if (!Number.isFinite(value)) throw new SymphonyConfigError("invalid_config", `${label} must be an integer`);
	return value;
}

function positiveIntegerAt(root: Record<string, unknown>, key: string, fallback: number, label: string): number {
	const value = integerConfigAt(root, key, fallback, label);
	if (value <= 0) throw new SymphonyConfigError("invalid_config", `${label} must be a positive integer`);
	return value;
}

function optionalPortAt(root: Record<string, unknown>, key: string, label: string): number | undefined {
	if (!(key in root)) return undefined;
	const value = integerConfigAt(root, key, 0, label);
	if (value < 0 || value > 65_535) throw new SymphonyConfigError("invalid_config", `${label} must be an integer between 0 and 65535`);
	return value;
}

function optionalIntegerAt(root: Record<string, unknown>, key: string): number | undefined {
	if (!(key in root)) return undefined;
	const value = asInteger(root[key], NaN);
	return Number.isFinite(value) ? value : undefined;
}

function asInteger(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isInteger(value)) return value;
	if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number.parseInt(value, 10);
	return fallback;
}

async function loadDotEnv(workflowDir: string): Promise<NodeJS.ProcessEnv> {
	try {
		const content = await readFile(resolve(workflowDir, ".env"), "utf8");
		return parseDotEnv(content);
	} catch {
		return {};
	}
}

function parseDotEnv(content: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const line of content.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
		if (!match) continue;
		const [, key, rawValue = ""] = match;
		env[key] = unquoteDotEnvValue(rawValue);
	}
	return env;
}

function unquoteDotEnvValue(value: string): string {
	const trimmed = value.trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1);
	}
	const hash = trimmed.indexOf(" #");
	return hash >= 0 ? trimmed.slice(0, hash).trimEnd() : trimmed;
}

function resolveDollar(value: string, env: NodeJS.ProcessEnv): string {
	if (!value.startsWith("$") || !/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return value;
	return env[value.slice(1)] ?? "";
}

function resolvePathValue(value: string, baseDir: string, env: NodeJS.ProcessEnv): string {
	let resolved = resolveDollar(value, env);
	if (resolved.startsWith("~/")) resolved = resolve(homedir(), resolved.slice(2));
	else if (resolved === "~") resolved = homedir();
	return isAbsolute(resolved) ? resolve(resolved) : resolve(baseDir, resolved);
}

export function normalizeState(state: string): string {
	return state.toLowerCase();
}

function normalizeError(error: unknown): { code: string; message: string } {
	if (error instanceof SymphonyConfigError) return { code: error.code, message: error.message };
	return { code: "invalid_config", message: errorMessage(error) };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
