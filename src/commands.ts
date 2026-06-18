import { spawn } from "node:child_process";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { createFileLogger } from "./logger.js";
import { SymphonyOrchestrator, type RunOnceResult } from "./orchestrator.js";
import { SymphonyConsole } from "./tui/console.js";
import { parseSymphonyArgs, symphonyLogPath, type OnceRunState, type SymphonyArgs, type SymphonyControls } from "./tui/data.js";

let daemon: SymphonyOrchestrator | null = null;
let daemonStartedAt: number | null = null;
let onceRun: OnceRunState | null = null;
let consoleOpen = false;
let statusTimer: ReturnType<typeof setInterval> | null = null;

type SymphonyCommandContext = {
	cwd: string;
	hasUI?: boolean;
	ui: {
		notify(message: string, type?: "info" | "warning" | "error" | "success"): void;
		setStatus(id: string, value: string | undefined): void;
		custom<T>(
			factory: (tui: any, theme: any, keybindings: any, done: (result: T) => void) => any,
			options?: unknown,
		): Promise<T>;
	};
};

export function registerSymphonyCommands(pi: ExtensionAPI): void {
	pi.registerCommand("symphony", {
		description: "Open the Symphony full-screen operator console",
		handler: async (args, ctx) => {
			const commandCtx = ctx as unknown as SymphonyCommandContext;
			if (commandCtx.hasUI === false) {
				commandCtx.ui.notify("/symphony requires interactive pi TUI mode", "error");
				return;
			}
			const parsed = parseSymphonyArgs(args);
			await openSymphonyConsole(commandCtx, parsed);
		},
	});

	pi.on("session_shutdown", async () => {
		if (daemon) await daemon.stop();
		daemon = null;
		daemonStartedAt = null;
		onceRun = null;
		consoleOpen = false;
		stopStatusTicker();
	});
}

async function openSymphonyConsole(ctx: SymphonyCommandContext, args: SymphonyArgs): Promise<void> {
	if (consoleOpen) {
		ctx.ui.notify("Symphony console is already open", "warning");
		return;
	}
	consoleOpen = true;
	try {
		await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) =>
				new SymphonyConsole(tui, theme, createControls(ctx), args, () => {
					consoleOpen = false;
					done();
				}),
			{
				overlay: true,
				overlayOptions: {
					anchor: "center",
					width: "100%",
					maxHeight: "100%",
					margin: 0,
				},
			},
		);
	} finally {
		consoleOpen = false;
	}
}

function createControls(ctx: SymphonyCommandContext): SymphonyControls {
	return {
		cwd: ctx.cwd,
		getRuntime: () => ({ daemon, daemonStartedAt, onceRun }),
		startDaemon: async (args) => {
			if (daemon) return;
			const logPath = symphonyLogPath(ctx.cwd, args.workflowPath);
			daemon = new SymphonyOrchestrator(ctx.cwd, args.workflowPath, createFileLogger(logPath), { portOverride: args.port });
			try {
				await daemon.start();
				daemonStartedAt = Date.now();
				startStatusTicker(ctx);
				setSymphonyStatus(ctx, "daemon running");
			} catch (error) {
				daemon = null;
				daemonStartedAt = null;
				stopStatusTicker();
				setSymphonyStatus(ctx, undefined);
				throw error;
			}
		},
		stopDaemon: async () => {
			const current = daemon;
			if (!current) return;
			await current.stop();
			daemon = null;
			daemonStartedAt = null;
			stopStatusTicker();
			setSymphonyStatus(ctx, undefined);
		},
		runOnce: async (selector, args) => {
			if (daemon) throw new Error("Stop daemon before running once.");
			const logPath = symphonyLogPath(ctx.cwd, args.workflowPath);
			const orchestrator = new SymphonyOrchestrator(ctx.cwd, args.workflowPath, createFileLogger(logPath), { portOverride: args.port });
			onceRun = { selector, startedAt: new Date().toISOString() };
			setSymphonyStatus(ctx, `once${selector ? ` ${selector}` : ""}`);
			try {
				const result = await orchestrator.runOnce(selector);
				onceRun = { ...onceRun, result };
				return result;
			} catch (error) {
				onceRun = { ...onceRun, error: error instanceof Error ? error.message : String(error) };
				throw error;
			} finally {
				await orchestrator.stop();
				onceRun = null;
				setSymphonyStatus(ctx, undefined);
			}
		},
		openExternal: async (target) => {
			const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
			const args = process.platform === "win32" ? ["/c", "start", "", target] : [target];
			await new Promise<void>((resolve, reject) => {
				const child = spawn(command, args, { stdio: "ignore", detached: true });
				child.once("error", reject);
				child.once("spawn", () => {
					child.unref();
					resolve();
				});
			});
		},
		setFooterStatus: (value) => setSymphonyStatus(ctx, value ? value.replace(/^♪\s*/, "") : undefined),
	};
}

function startStatusTicker(ctx: SymphonyCommandContext): void {
	stopStatusTicker();
	statusTimer = setInterval(() => setSymphonyStatus(ctx, "daemon running"), 1_000);
	statusTimer.unref?.();
}

function stopStatusTicker(): void {
	if (statusTimer) clearInterval(statusTimer);
	statusTimer = null;
}

function setSymphonyStatus(ctx: SymphonyCommandContext, value: string | undefined): void {
	ctx.ui.setStatus("symphony", value ? `♪ ${formatSymphonyStatus(value)}` : undefined);
}

function formatSymphonyStatus(value: string): string {
	if (value !== "daemon running" || !daemon) return value;
	const snapshot = objectValue(daemon.snapshot()) ?? {};
	const counts = objectValue(snapshot.counts) ?? {};
	const runningRows = Array.isArray(snapshot.running) ? snapshot.running : [];
	const active = numberValue(counts.running) ?? runningRows.length;
	const total = numberValue(snapshot.max_concurrent_agents) ?? daemon.getConfig()?.agent.maxConcurrentAgents ?? "?";
	return `${value} (${active}/${total})`;
}

function objectValue(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function numberValue(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}
