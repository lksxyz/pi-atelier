import { describe, expect, test } from "bun:test";
import { captureCheckpoint, resumePrompt } from "../src/checkpoint.ts";
import { makePausedNotice } from "../src/format.ts";
import type { RunSnapshot, TaskSnapshot, UsageStats } from "../src/types.ts";

const usage: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };

function task(over: Partial<TaskSnapshot> = {}): TaskSnapshot {
	return {
		id: "task_1",
		runId: "run_1",
		agent: "worker",
		task: "refactor the parser",
		cwd: "/tmp",
		status: "paused",
		toolCalls: 3,
		usage,
		...over,
	};
}

function run(tasks: TaskSnapshot[], over: Partial<RunSnapshot> = {}): RunSnapshot {
	return {
		id: "run_1",
		mode: "single",
		status: "paused",
		notifyPerTask: true,
		createdAt: 1,
		concurrency: 1,
		tasks,
		aggregateUsage: usage,
		...over,
	};
}

describe("captureCheckpoint", () => {
	test("records the last step, the workspace, and where to continue", () => {
		const checkpoint = captureCheckpoint(
			task({
				sessionFile: "/tmp/child.jsonl",
				lastActivity: "Edit src/parser.ts",
				branch: "subagent/run_1/task_1",
				changedFiles: ["src/parser.ts"],
			}),
			1234,
		);
		expect(checkpoint.at).toBe(1234);
		expect(checkpoint.progress).toBe("Edit src/parser.ts");
		expect(checkpoint.branch).toBe("subagent/run_1/task_1");
		expect(checkpoint.changedFiles).toEqual(["src/parser.ts"]);
		expect(checkpoint.nextAction).toContain('resume_subagent(runId: "run_1", taskId: "task_1")');
		expect(checkpoint.unresolved).toBeUndefined();
	});
	test("a pending question is the unresolved decision, and answering it is the next action", () => {
		const checkpoint = captureCheckpoint(
			task({ sessionFile: "/tmp/child.jsonl", pendingQuestion: "which database?" }),
			1,
		);
		expect(checkpoint.unresolved).toBe("which database?");
		expect(checkpoint.nextAction).toContain("which database?");
	});
	test("without a session file the checkpoint says respawn, never resume", () => {
		const checkpoint = captureCheckpoint(task({ lastActivity: "Bash bun test" }), 1);
		expect(checkpoint.progress).toBe("Bash bun test");
		expect(checkpoint.nextAction).toContain("respawn");
		expect(checkpoint.nextAction).not.toContain("resume_subagent");
	});
	test("no recorded step still produces an honest checkpoint", () => {
		const checkpoint = captureCheckpoint(task({ finalText: "", sessionFile: "/tmp/child.jsonl" }), 1);
		expect(checkpoint.progress).toContain("No step recorded");
	});
});

describe("resumePrompt", () => {
	test("a paused task is described as interrupted, not as an error", () => {
		const prompt = resumePrompt(task({ checkpoint: captureCheckpoint(task({ sessionFile: "/tmp/child.jsonl" }), 1) }));
		expect(prompt).toContain("interrupted");
		expect(prompt).not.toContain("ended with an error");
	});
	test("a paused task carries its unanswered question into the resume prompt", () => {
		const pending = task({ sessionFile: "/tmp/child.jsonl", pendingQuestion: "which database?" });
		const prompt = resumePrompt({ ...pending, checkpoint: captureCheckpoint(pending, 1) });
		expect(prompt).toContain("which database?");
	});
	test("a failed task keeps the error wording", () => {
		const prompt = resumePrompt(task({ status: "failed", error: "usage limit" }));
		expect(prompt).toContain("usage limit");
		expect(prompt).toContain("Resume where you left off");
	});
});

describe("makePausedNotice", () => {
	test("lists every paused task with its next action and the resume call", () => {
		const paused = task({
			sessionFile: "/tmp/child.jsonl",
			lastActivity: "Edit src/parser.ts",
			checkpoint: captureCheckpoint(task({ sessionFile: "/tmp/child.jsonl", lastActivity: "Edit src/parser.ts" }), 1),
		});
		const notice = makePausedNotice(
			run([paused, task({ id: "task_2", status: "completed", sessionFile: "/tmp/other.jsonl" })]),
		);
		expect(notice).toContain("paused");
		expect(notice).toContain("task_1");
		expect(notice).toContain("Edit src/parser.ts");
		expect(notice).toContain('resume_subagent(runId: "run_1", taskId: "task_1")');
		expect(notice).toContain("1 paused");
	});
});
