/**
 * Per-session store + sidecar persistence. One Map keyed by session id
 * (detached/child sessions never clobber each other). Persisted to a single
 * JSON sidecar in the agent dir — replaces rpiv-todo's branch replay; survives
 * restarts, does not replay history across forks.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { type TaskState, EMPTY_STATE } from "./types.ts";

const sessions = new Map<string, TaskState>();
let activeRenderSession = "";
let persistScheduled = false;

export function sid(ctx: { sessionManager?: { getSessionId?(): string } }): string {
	try {
		return ctx.sessionManager?.getSessionId?.() ?? "";
	} catch {
		return "";
	}
}

function freshState(): TaskState {
	return { tasks: [...EMPTY_STATE.tasks], nextId: EMPTY_STATE.nextId };
}

function stateFile(): string {
	return path.join(getAgentDir(), "pi-todo-state.json");
}

const loadFromDisk = Effect.fnUntraced(function* (): Effect.fn.Return<void> {
	const raw = yield* Effect.tryPromise({
		try: () => fs.readFile(stateFile(), "utf-8").then((text) => JSON.parse(text) as Record<string, TaskState>),
		catch: () => undefined,
	}).pipe(Effect.catch(() => Effect.void));
	if (!raw) return;
	for (const [k, v] of Object.entries(raw)) {
		if (!k) continue;
		if (!v || !Array.isArray(v.tasks) || typeof v.nextId !== "number") continue;
		if (sessions.has(k)) continue;
		const maxId = v.tasks.reduce((m, t) => Math.max(m, t.id ?? 0), 0);
		if (v.nextId <= maxId) v.nextId = maxId + 1;
		sessions.set(k, v);
	}
});

const writeDisk = Effect.fnUntraced(function* (): Effect.fn.Return<void> {
	const file = stateFile();
	const tmp = `${file}.tmp`;
	yield* Effect.tryPromise({
		try: async () => {
			await fs.mkdir(path.dirname(file), { recursive: true });
			await fs.writeFile(tmp, JSON.stringify(Object.fromEntries([...sessions].filter(([k]) => k !== ""))));
			await fs.rename(tmp, file);
		},
		catch: () => undefined,
	}).pipe(Effect.catch(() => Effect.void));
});

/** Debounced write of the whole map. Called on every commit; cheap at this cadence. */
export const schedulePersist = Effect.fnUntraced(function* (): Effect.fn.Return<void> {
	if (persistScheduled) return;
	persistScheduled = true;
	yield* Effect.forkDetach(
		Effect.sleep("500 millis").pipe(
			Effect.andThen(writeDisk()),
			Effect.ensuring(Effect.sync(() => { persistScheduled = false; })),
		),
	);
});

export function getState(sessionId: string): TaskState {
	return sessions.get(sessionId) ?? freshState();
}

export const commitState = Effect.fnUntraced(function* (sessionId: string, state: TaskState): Effect.fn.Return<void> {
	sessions.set(sessionId, state);
	yield* schedulePersist();
});

export function setActiveRenderSession(id: string): void {
	activeRenderSession = id;
}
export function clearActiveRenderSession(): void {
	activeRenderSession = "";
}
export function getActiveRenderSession(): string {
	return activeRenderSession;
}

/** Ctx-less render pointer: the foreground session's state, or empty. */
export function getRenderState(): TaskState {
	return getState(activeRenderSession);
}

/** Restore the given session's slot from disk. Returns true when restored. */
export const restoreSession = Effect.fnUntraced(function* (sessionId: string): Effect.fn.Return<boolean> {
	if (!sessions.has(sessionId)) yield* loadFromDisk();
	return sessions.has(sessionId);
});

/** Does the session have a live state slot? (widget reclaim check) */
export function hasSession(sessionId: string): boolean {
	return sessions.has(sessionId);
}

