import { Cause, Effect, Exit, Option } from "effect";
import type { RunMode } from "./types.ts";

export function resolveNeeds(inputs: { id?: string; needs?: string[] }[], mode: RunMode): string[][] {
	const ids = inputs.map((input, index) => input.id ?? `task_${index + 1}`);
	const known = new Set(ids);
	const edges = inputs.map((input, index) => {
		if (mode === "chain") return index === 0 ? [] : [ids[index - 1] as string];
		const needs = input.needs ?? [];
		for (const need of needs) {
			if (!known.has(need)) throw new Error(`Task ${ids[index]} needs unknown task id: ${need}`);
			if (need === ids[index]) throw new Error(`Task ${ids[index]} cannot need itself.`);
		}
		return [...new Set(needs)];
	});

	const done = new Set<string>();
	let progress = true;
	while (progress) {
		progress = false;
		for (const [index, id] of ids.entries()) {
			if (done.has(id)) continue;
			if ((edges[index] as string[]).every((need) => done.has(need))) {
				done.add(id);
				progress = true;
			}
		}
	}
	if (done.size !== ids.length) {
		throw new Error(`Cycle in subagent needs: ${ids.filter((id) => !done.has(id)).join(", ")}`);
	}
	return edges;
}

export function waveNotation(tasks: { id?: string; needs?: string[] }[]): string {
	if (!tasks.some((t) => t.needs?.length)) return "";
	const ids = tasks.map((t, i) => t.id ?? `task_${i + 1}`);
	const settled = new Set<string>();
	let remaining = tasks.map((t, i) => ({ id: ids[i] as string, needs: t.needs ?? [] }));
	const waves: string[][] = [];
	while (remaining.length > 0) {
		const ready = remaining.filter((t) => t.needs.every((n) => settled.has(n)));
		if (ready.length === 0) break;
		waves.push(ready.map((t) => t.id));
		for (const t of ready) settled.add(t.id);
		remaining = remaining.filter((t) => !settled.has(t.id));
	}
	if (remaining.length > 0) waves.push(remaining.map((t) => t.id));
	if (waves.length < 2) return "";
	const full = waves.map((w, i) => `wave${i + 1}[${w.join(" ∥ ")}]`).join(" → gate → ");

	return full.length <= 100 ? full : waves.map((w, i) => `wave${i + 1}[${w.length}]`).join(" → gate → ");
}

export function applyUpstream(task: string, needs: string[], outputs: Map<string, string>): string {
	if (needs.length === 0) {
		return task.includes("{previous}")
			? `${task.replace(/\{previous\}/g, () => "")}\n\n(Note: {previous} was empty — no prior step output existed yet.)`
			: task;
	}
	const first = outputs.get(needs[0] as string) ?? "";
	const body = task.replace(/\{previous\}/g, () => first);
	const blocks = needs.map((need) => `## Output of ${need}\n${outputs.get(need) ?? "(no output)"}`);
	return `${blocks.join("\n\n")}\n\n---\n\n${body}`;
}

export interface SchedulerTask {
	id: string;
	needs?: string[];
}

export interface SkippedTask {
	id: string;
	needs: string[];
}

const awaitAbort = (signal: AbortSignal): Effect.Effect<never> =>
	Effect.callback<never>((resume) => {
		if (signal.aborted) return resume(Effect.interrupt);
		const onAbort = () => resume(Effect.interrupt);
		signal.addEventListener("abort", onAbort, { once: true });
		return Effect.sync(() => {
			signal.removeEventListener("abort", onAbort);
		});
	});

const runConcurrent = <T>(
	items: T[],
	concurrency: number,
	fn: (item: T, index: number, signal: AbortSignal) => Effect.Effect<void, unknown>,
	externalSignal?: AbortSignal,
): Effect.Effect<void, unknown> =>
	Effect.gen(function* () {
		if (externalSignal?.aborted) return yield* Effect.interrupt;
		const runWave = Effect.forEach(
			items,
			(item, index) =>
				Effect.scoped(Effect.gen(function* () {
					const fiberSignal = yield* Effect.abortSignal;
					return yield* fn(item, index, externalSignal ? AbortSignal.any([externalSignal, fiberSignal]) : fiberSignal);
				}).pipe(Effect.asVoid)).pipe(Effect.exit),
			{ concurrency: Math.max(1, Math.min(concurrency, items.length)) },
		).pipe(Effect.flatMap((results) => {
			const failure = results.find(Exit.isFailure);
			if (failure && Exit.isFailure(failure)) {
				const error = Cause.findErrorOption(failure.cause);
				if (Option.isSome(error)) return Effect.fail(error.value);
				return Effect.failCause(failure.cause);
			}
			return Effect.void;
		}));
		return externalSignal ? yield* Effect.raceFirst(runWave, awaitAbort(externalSignal)) : yield* runWave;
	});

export const runWaveSchedulerEffect = <T extends SchedulerTask>(
	tasks: T[],
	concurrency: number,
	outputs: Map<string, string>,
	settled: Set<string>,
	run: (task: T, index: number, signal: AbortSignal) => Effect.Effect<void, unknown>,
	signal?: AbortSignal,
): Effect.Effect<{ skipped: SkippedTask[] }, unknown> =>
	Effect.gen(function* () {
		let remaining = [...tasks];
		const skipped: SkippedTask[] = [];
		while (remaining.length > 0) {
			const ready = remaining.filter((t) => (t.needs ?? []).every((need) => settled.has(need)));
			if (ready.length === 0) break;
			yield* runConcurrent(
				ready,
				concurrency,
				(task, _index, workerSignal) => {
					const index = tasks.indexOf(task);
					const needs = task.needs ?? [];
					const broken = needs.filter((need) => !outputs.has(need));
					if (broken.length > 0) {
						skipped.push({ id: task.id, needs: broken });
						return Effect.void;
					}
					return run(task, index, workerSignal);
				},
				signal,
			);
			for (const task of ready) settled.add(task.id);
			remaining = remaining.filter((t) => !settled.has(t.id));
		}
		return { skipped };
	});

export function runWaveScheduler<T extends SchedulerTask>(
	tasks: T[],
	concurrency: number,
	outputs: Map<string, string>,
	settled: Set<string>,
	run: (task: T, index: number, signal: AbortSignal) => Promise<void>,
	signal?: AbortSignal,
): Promise<{ skipped: SkippedTask[] }> {
	return Effect.runPromise(runWaveSchedulerEffect(
		tasks,
		concurrency,
		outputs,
		settled,
		(task, index, workerSignal) => Effect.tryPromise({
			try: () => run(task, index, workerSignal),
			catch: (error) => error,
		}),
		signal,
	));
}
