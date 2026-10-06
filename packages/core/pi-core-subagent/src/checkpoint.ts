import { activitySnippet } from "./format.ts";
import type { Checkpoint, TaskSnapshot } from "./types.ts";

/**
 * Snapshot of a stopped task, captured at the moment it stops (a reload or a lost process), so the
 * next actor inspects recorded state instead of rebuilding it. Pure: the checkpoint is derived from
 * the task alone, which is what makes the pause/resume path testable without a session.
 */
export function captureCheckpoint(task: TaskSnapshot, at = Date.now()): Checkpoint {
	const progress =
		task.lastActivity?.trim() || activitySnippet(task.finalText ?? "") || "No step recorded before the stop.";
	const resume = task.sessionFile
		? `resume_subagent(runId: "${task.runId}", taskId: "${task.id}") continues it from the saved session`
		: "no session file survived, so respawn the task instead of resuming it";
	const question = task.pendingQuestion?.trim();
	return {
		at,
		progress,
		nextAction: question
			? `Answer "${question}", then ${resume}.`
			: `Inspect the workspace (branch ${task.branch ?? "none"}, ${task.changedFiles?.length ?? 0} changed file(s)), then ${resume}.`,
		unresolved: question,
		branch: task.branch,
		changedFiles: task.changedFiles,
	};
}

/** Default resume prompt: a paused task was interrupted, a failed one errored — they say different things. */
export function resumePrompt(task: TaskSnapshot): string {
	const recap = "Briefly recap what you already did and what remains, then continue and finish the original task.";
	if (task.status !== "paused") {
		return `Your previous turn ended with an error (${task.error ?? "unknown"}). Resume where you left off: ${recap}`;
	}
	const question = task.checkpoint?.unresolved ?? task.pendingQuestion?.trim();
	const progress = task.checkpoint?.progress ?? task.lastActivity ?? "unknown";
	return [
		`This task was interrupted before it finished (last step: ${progress}).`,
		question
			? `You were waiting for an answer to: "${question}". If the parent has answered since, use that answer; otherwise proceed with your best judgment.`
			: "",
		recap,
	]
		.filter(Boolean)
		.join(" ");
}
