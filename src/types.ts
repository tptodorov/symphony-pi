export interface BlockerRef {
	id: string | null;
	identifier: string | null;
	state: string | null;
}

export interface Issue {
	id: string;
	identifier: string;
	title: string;
	description: string | null;
	priority: number | null;
	state: string;
	branch_name: string | null;
	url: string | null;
	labels: string[];
	blocked_by: BlockerRef[];
	created_at: string | null;
	updated_at: string | null;
}

export interface WorkflowDefinition {
	path: string;
	config: Record<string, unknown>;
	prompt_template: string;
}

export type TrackerKind = "linear" | "jira" | "beads";
export type RunnerKind = "codex" | "pi";

export interface SymphonyConfig {
	workflowPath: string;
	workflowDir: string;
	tracker: {
		kind: TrackerKind;
		endpoint: string;
		apiKey: string | null;
		projectSlug: string;
		jiraEmail: string | null;
		jiraApiToken: string | null;
		jiraProjectKey: string;
		jiraJql: string | null;
		jiraPageSize?: number;
		beadsCommand: string;
		beadsReadyCommand: string;
		activeStates: string[];
		terminalStates: string[];
	};
	polling: { intervalMs: number };
	workspace: { root: string };
	hooks: {
		afterCreate: string | null;
		beforeRun: string | null;
		afterRun: string | null;
		beforeRemove: string | null;
		timeoutMs: number;
	};
	agent: {
		maxConcurrentAgents: number;
		maxTurns: number;
		maxRetryBackoffMs: number;
		maxConcurrentAgentsByState: Record<string, number>;
	};
	runner: { kind: RunnerKind };
	codex: {
		command: string;
		approvalPolicy?: unknown;
		threadSandbox?: unknown;
		turnSandboxPolicy?: unknown;
		turnTimeoutMs: number;
		readTimeoutMs: number;
		stallTimeoutMs: number;
	};
	pi: {
		command: string;
		modelProvider: string | null;
		modelId: string | null;
		thinkingLevel: string | null;
		turnTimeoutMs: number;
		readTimeoutMs: number;
		stallTimeoutMs: number;
	};
	server: { port?: number };
}

export type ConfigErrorCode =
	| "missing_workflow_file"
	| "workflow_parse_error"
	| "workflow_front_matter_not_a_map"
	| "unsupported_tracker_kind"
	| "missing_tracker_kind"
	| "missing_tracker_api_key"
	| "missing_tracker_project_slug"
	| "missing_jira_email"
	| "missing_jira_api_token"
	| "missing_jira_project_key"
	| "missing_codex_command"
	| "missing_pi_command"
	| "unsupported_runner_kind"
	| "invalid_config";

export class SymphonyConfigError extends Error {
	constructor(
		public readonly code: ConfigErrorCode,
		message: string,
	) {
		super(message);
		this.name = "SymphonyConfigError";
	}
}

export type TemplateErrorCode = "template_parse_error" | "template_render_error";

export class SymphonyTemplateError extends Error {
	constructor(
		public readonly code: TemplateErrorCode,
		message: string,
	) {
		super(message);
		this.name = "SymphonyTemplateError";
	}
}

export interface RecentRuntimeEvent {
	at: string;
	event: string;
	message: string | null;
}

export interface RecentAgentMessage {
	at: string;
	text: string;
	streaming: boolean;
}

export interface CodexRuntimeEvent {
	event: string;
	timestamp: string;
	codex_app_server_pid?: string | null;
	thread_id?: string;
	turn_id?: string;
	session_id?: string;
	message?: string;
	usage?: unknown;
	rate_limits?: unknown;
	payload?: unknown;
}

export interface LiveSession {
	session_id: string | null;
	thread_id: string | null;
	turn_id: string | null;
	codex_app_server_pid: string | null;
	last_codex_event: string | null;
	last_codex_timestamp: string | null;
	last_codex_message: string | null;
	codex_input_tokens: number;
	codex_output_tokens: number;
	codex_total_tokens: number;
	last_reported_input_tokens: number;
	last_reported_output_tokens: number;
	last_reported_total_tokens: number;
	turn_count: number;
	recent_events: RecentRuntimeEvent[];
	recent_agent_messages: RecentAgentMessage[];
	current_agent_message: string | null;
	current_agent_message_at: string | null;
}

export type RunStatus = "succeeded" | "failed" | "cancelled";
export type RunTerminalReason = "succeeded" | "failed" | "timed_out" | "stalled" | "user_input_required" | "cancelled_by_reconciliation" | "cancelled";

export interface RunningEntry extends LiveSession {
	issue: Issue;
	identifier: string;
	started_at: string;
	workspace_path: string | null;
	artifact_path: string | null;
	retry_attempt: number | null;
	abort: AbortController;
	abort_reason: RunTerminalReason | null;
	promise: Promise<void>;
	last_error: string | null;
	terminal_reason: RunTerminalReason | null;
}

export interface RetryEntry {
	issue_id: string;
	identifier: string;
	attempt: number;
	due_at_ms: number;
	timer_handle: NodeJS.Timeout;
	error: string | null;
	artifact_path?: string | null;
	terminal_reason?: RunTerminalReason | null;
}

export interface CodexTotals {
	input_tokens: number;
	output_tokens: number;
	total_tokens: number;
	seconds_running: number;
}

export interface OrchestratorState {
	poll_interval_ms: number;
	max_concurrent_agents: number;
	running: Map<string, RunningEntry>;
	claimed: Set<string>;
	retry_attempts: Map<string, RetryEntry>;
	completed: Set<string>;
	codex_totals: CodexTotals;
	codex_rate_limits: unknown;
}

export interface Logger {
	info(message: string, fields?: Record<string, unknown>): void;
	warn(message: string, fields?: Record<string, unknown>): void;
	error(message: string, fields?: Record<string, unknown>): void;
	debug(message: string, fields?: Record<string, unknown>): void;
}
