export type RunMode = "single" | "parallel" | "chain";
export type TaskStatus =
	| "queued"
	| "starting"
	| "running"
	| "awaiting_parent"
	| "paused"
	| "completed"
	| "failed"
	| "aborted";
export type RunStatus = "queued" | "running" | "awaiting_parent" | "paused" | "completed" | "failed" | "aborted";

/** Finished for good: history, nothing left pending. */
export const TERMINAL: TaskStatus[] = ["completed", "failed", "aborted"];

/** Work in flight right now. `paused` is neither live nor settled — it moves only when resumed. */
export const LIVE: TaskStatus[] = ["queued", "starting", "running", "awaiting_parent"];

const LIVE_SET = new Set<string>(LIVE);
const SETTLED_SET = new Set<string>(TERMINAL);

export function isLive(status: TaskStatus | RunStatus): boolean {
	return LIVE_SET.has(status);
}
export function isSettled(status: TaskStatus | RunStatus): boolean {
	return SETTLED_SET.has(status);
}

export const MAX_TASKS = 16;

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

/**
 * What a stopped task leaves behind, so resuming never starts from guesswork: where it got to,
 * what stayed unresolved, and which workspace state to inspect before continuing.
 */
export interface Checkpoint {
	at: number;
	progress: string;
	nextAction: string;
	unresolved?: string;
	branch?: string;
	changedFiles?: string[];
}

export interface TaskSnapshot {
	id: string;
	runId: string;
	agent: string;
	task: string;
	cwd: string;
	status: TaskStatus;
	needs?: string[];
	sessionId?: string;
	sessionFile?: string;
	startedAt?: number;
	endedAt?: number;
	toolCalls: number;
	lastActivity?: string;
	finalText?: string;
	notifiedParent?: boolean;
	error?: string;
	model?: string;
	provider?: string;
	modelNote?: string;
	toolsNote?: string;
	thinking?: string;
	tools?: string[];
	usage: UsageStats;
	roster?: string;
	agentFile?: string;
	branch?: string;
	diffStat?: string;
	changedFiles?: string[];
	isolation?: "worktree" | "in-place";
	isolationReason?: string;
	stackedOn?: string;
	worktreeError?: string;
	/** The question this task is parked on, kept across a reload so the pause notice can name it. */
	pendingQuestion?: string;
	checkpoint?: Checkpoint;
}

export interface RunSnapshot {
	id: string;
	mode: RunMode;
	status: RunStatus;
	notifyPerTask: boolean;
	createdAt: number;
	startedAt?: number;
	endedAt?: number;
	concurrency: number;
	tasks: TaskSnapshot[];
	aggregateUsage: UsageStats;
	awaited?: boolean;
}

export interface RunDetails {
	run: RunSnapshot;
}

export interface PendingReply {
	resolve: (message: string) => void;
}

/** Per-million-token USD rates, as pi reports them. */
export interface ModelPricing {
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
}

/** One selectable model, as the agent needs it to choose: what to pass, what it supports, what it costs. */
export interface SelectableModel {
	/** The value to pass as `model` ("provider/id"). */
	reference: string;
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	/** Levels the runtime honors without clamping. */
	thinkingLevels: string[];
	/** 0 when the provider did not report one. */
	contextWindow: number;
	/** pi's catalog rates, or undefined when the provider reported none — distinct from free. */
	cost?: ModelPricing;
}

export interface ModelCatalog {
	models: SelectableModel[];
	/**
	 * What the list was scoped to. pi resolves `enabledModels` (and `--models`) into scoped models,
	 * so this is normally the session's own enabled set rather than every model with credentials.
	 */
	scope: "session" | "all";
	/** The config's suggested model, surfaced for the caller to weigh. Never applied automatically. */
	preferredDefault?: string;
	unlistedDefault?: string;
	/** Set when the preferences file existed but was unusable, so a typo is reported, not silent. */
	configError?: string;
	/** How many models the config hid, so a surprising absence is explained. */
	hidden?: number;
	/** Preferred/hidden patterns that matched no listed model — inert config, reported not hidden. */
	unusedPatterns?: string[];
	/** References that are NOT safe to pass because another model's bare id would win resolution. */
	ambiguous?: string[];
	/** Why the ambiguous references are unsafe, in full, so the agent can act instead of retrying blindly. */
	reason?: string;
	/** Entries the registry itself could not resolve — a registry fault, distinct from a name collision. */
	unresolved?: string[];
	/** Why those entries failed, so a registry fault is never mistaken for a collision. */
	unresolvedReason?: string;
	/** Set when the catalog is empty, so the caller knows it is not looking at a legitimate empty list. */
	unavailable?: string;
}
