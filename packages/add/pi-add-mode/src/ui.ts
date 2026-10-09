import { Effect } from "effect";
import { DynamicBorder, type ExtensionContext, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, Input, matchesKey, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { colorize, colorLabel } from "./colors.ts";
import type { ModeEngine } from "./engine.ts";
import { describeTools, isDefaultModeName, parseToolList, thinkingLevelsFor } from "./logic.ts";
import type { ModeStore } from "./store.ts";
import {
	COLOR_PALETTE,
	DEFAULT_MODE_NAME,
	type Mode,
	type ModeThinking,
	type ModeTools,
	THINKING_LEVELS,
	TOOL_PRESETS,
	type ToolPreset,
} from "./types.ts";

interface ThinkingModel {
	reasoning: boolean;
	thinkingLevelMap?: Record<string, string | null>;
}

type PanelAction = "activate" | "edit" | "toggle" | "delete" | "new";

interface PanelChoice {
	action: PanelAction;
	name?: string;
}

const fromPromise = <A>(evaluate: () => PromiseLike<A>): Effect.Effect<A, unknown> =>
	Effect.tryPromise({ try: evaluate, catch: (error) => error });

function modeSummary(mode: Mode, theme: ExtensionContext["ui"]["theme"]): string {
	const parts: string[] = [mode.enabled ? "enabled" : theme.fg("dim", "disabled")];
	parts.push(`tools: ${describeTools(mode.tools)}`);
	parts.push(mode.model ? `${mode.model}${mode.thinking ? `:${mode.thinking}` : ""}` : "default model");
	if (mode.subagentModel)
		parts.push(`sub: ${mode.subagentModel}${mode.subagentThinking ? `:${mode.subagentThinking}` : ""}`);
	if (mode.instructions) parts.push("+instructions");
	return parts.join(" · ");
}

function showPanel(
	ctx: ExtensionContext,
	engine: ModeEngine,
	store: ModeStore,
): Effect.Effect<PanelChoice | undefined, unknown> {
	return fromPromise(() =>
		ctx.ui.custom<PanelChoice | undefined>((tui, theme, _keybindings, done) => {
			const activeName = engine.activeName ?? DEFAULT_MODE_NAME;
			const items: SelectItem[] = [
				{
					value: DEFAULT_MODE_NAME,
					label: `${activeName === DEFAULT_MODE_NAME ? "● " : "  "}${theme.fg("accent", DEFAULT_MODE_NAME)}`,
					description: "built-in · vanilla pi",
				},
			];
			for (const mode of store.list()) {
				items.push({
					value: mode.name,
					label: `${activeName === mode.name ? "● " : "  "}${colorize(mode.name, mode.color, theme)}`,
					description: modeSummary(mode, theme),
				});
			}

			const list = new SelectList(items, Math.min(items.length, 14), getSelectListTheme());
			const container = new Container();
			list.onSelect = (item) => done({ action: "activate", name: item.value });
			list.onCancel = () => done(undefined);
			container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
			container.addChild(new Text(theme.fg("accent", theme.bold("Modes"))));
			container.addChild(list);
			container.addChild(
				new Text(
					theme.fg("dim", "↑↓ move • enter activate • e edit • space enable/disable • n new • d delete • esc close"),
					1,
					0,
				),
			);
			container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));

			const selected = () => list.getSelectedItem();
			return {
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					if (matchesKey(data, "space")) {
						const item = selected();
						if (item && item.value !== DEFAULT_MODE_NAME) done({ action: "toggle", name: item.value });
						return;
					}
					if (data === "e") {
						const item = selected();
						if (item && item.value !== DEFAULT_MODE_NAME) done({ action: "edit", name: item.value });
						return;
					}
					if (data === "n") {
						done({ action: "new" });
						return;
					}
					if (data === "d") {
						const item = selected();
						if (item && item.value !== DEFAULT_MODE_NAME) done({ action: "delete", name: item.value });
						return;
					}
					list.handleInput(data);
					tui.requestRender();
				},
			};
		}),
	);
}

export function openModePanel(
	ctx: ExtensionContext,
	engine: ModeEngine,
	store: ModeStore,
): Effect.Effect<void, unknown> {
	return Effect.gen(function* () {
		if (!ctx.hasUI) return;
		for (;;) {
			const choice = yield* showPanel(ctx, engine, store);
			if (!choice) return;
			const mode = choice.name ? store.get(choice.name) : undefined;

			if (choice.action === "activate" && choice.name) {
				yield* engine.switchTo(choice.name === DEFAULT_MODE_NAME ? undefined : choice.name, ctx);
				return;
			}
			if (choice.action === "toggle" && mode) {
				mode.enabled = !mode.enabled;
				store.upsert(mode);
				store.save();
				continue;
			}
			if (choice.action === "delete" && mode) {
				const ok = yield* fromPromise(() => ctx.ui.confirm("Delete mode", `Delete mode "${mode.name}"?`));
				if (ok) {
					store.remove(mode.name);
					store.save();
					if (engine.activeName === mode.name) yield* engine.switchTo(undefined, ctx);
				}
				continue;
			}
			if (choice.action === "new") {
				yield* createMode(ctx, engine, store);
				continue;
			}
			if (choice.action === "edit" && mode) yield* editMode(ctx, engine, store, mode.name);
		}
	});
}

export function createMode(ctx: ExtensionContext, engine: ModeEngine, store: ModeStore): Effect.Effect<void, unknown> {
	return Effect.gen(function* () {
		if (!ctx.hasUI) return;
		const raw = yield* fromPromise(() => ctx.ui.input("New mode name", "e.g. review"));
		if (raw === undefined) return;
		const name = raw.trim();
		if (!name) {
			ctx.ui.notify("Mode name is required", "error");
			return;
		}
		if (isDefaultModeName(name)) {
			ctx.ui.notify(`"${name}" is reserved for the built-in default mode`, "error");
			return;
		}
		if (store.get(name)) {
			ctx.ui.notify(`Mode "${name}" already exists`, "error");
			return;
		}
		store.upsert({ name, enabled: true, tools: "default" });
		store.save();
		ctx.ui.notify(`Mode "${name}" created`, "info");
		yield* editMode(ctx, engine, store, name);
	});
}

function renameMode(
	ctx: ExtensionContext,
	store: ModeStore,
	oldName: string,
): Effect.Effect<string | undefined, unknown> {
	return Effect.gen(function* () {
		const raw = yield* fromPromise(() => ctx.ui.input(`Rename mode "${oldName}"`, oldName));
		if (raw === undefined) return undefined;
		const next = raw.trim();
		if (!next || next === oldName) return undefined;
		if (isDefaultModeName(next) || store.get(next)) {
			ctx.ui.notify(`Mode "${next}" already exists`, "error");
			return undefined;
		}
		store.rename(oldName, next);
		store.save();
		return next;
	});
}

function pickColor(ctx: ExtensionContext, current: string | undefined): Effect.Effect<string | undefined, unknown> {
	const theme = ctx.ui.theme;
	const options = [
		`${current ? "" : "✓ "}(none)`,
		...COLOR_PALETTE.map(
			(entry) => `${current === entry.value ? "✓ " : ""}${entry.name}  ${colorize("██", entry.value, theme)}`,
		),
	];
	return Effect.map(
		fromPromise(() => ctx.ui.select("Colour", options)),
		(choice) => {
			if (choice === undefined) return undefined;
			const index = options.indexOf(choice);
			return index <= 0 ? "" : (COLOR_PALETTE[index - 1]?.value ?? "");
		},
	);
}

function pickTools(ctx: ExtensionContext, current: ModeTools): Effect.Effect<ModeTools | undefined, unknown> {
	return Effect.gen(function* () {
		const custom = Array.isArray(current) ? current.join(", ") : "";
		const presetLabels = TOOL_PRESETS.map((preset) => `${current === preset ? "✓ " : ""}${preset}`);
		const options = [...presetLabels, `${Array.isArray(current) ? "✓ " : ""}custom… (${custom || "none"})`];
		const choice = yield* fromPromise(() => ctx.ui.select("Tool set", options));
		if (choice === undefined) return undefined;
		const index = options.indexOf(choice);
		if (index >= 0 && index < TOOL_PRESETS.length) return TOOL_PRESETS[index] as ToolPreset;
		const text = yield* fromPromise(() => ctx.ui.editor("Tool names (comma or space separated)", custom));
		if (text === undefined) return undefined;
		const names = parseToolList(text);
		return names.length > 0 ? names : "default";
	});
}

function resolveModel(ctx: ExtensionContext, ref: string | undefined): ThinkingModel | undefined {
	if (!ref) return ctx.model;
	const slash = ref.indexOf("/");
	if (slash <= 0 || slash === ref.length - 1) return undefined;
	return ctx.modelRegistry.find(ref.slice(0, slash), ref.slice(slash + 1));
}

/** Effort picker. Returns undefined on cancel, "" for default/inherit, or a thinking level. */
function pickThinking(
	ctx: ExtensionContext,
	title: string,
	current: ModeThinking | undefined,
	model: ThinkingModel | undefined,
): Effect.Effect<ModeThinking | "" | undefined, unknown> {
	const available = thinkingLevelsFor(model);
	const levels = THINKING_LEVELS.filter((level) => available.includes(level) || level === current);
	const options = [
		`${current ? "" : "✓ "}(default)`,
		...levels.map((level) => `${current === level ? "✓ " : ""}${level}`),
	];
	return Effect.map(
		fromPromise(() => ctx.ui.select(title, options)),
		(choice) => {
			if (choice === undefined) return undefined;
			const index = options.indexOf(choice);
			return index <= 0 ? "" : (levels[index - 1] ?? "");
		},
	);
}

export function pickModel(
	ctx: ExtensionContext,
	title: string,
	current: string | undefined,
): Effect.Effect<string | undefined, unknown> {
	const items: SelectItem[] = [
		{ value: "", label: "(default)", description: "inherit the session model" },
		...ctx.modelRegistry.getAvailable().map((model) => ({
			value: `${model.provider}/${model.id}`,
			label: model.id,
			description: model.provider,
		})),
	];
	if (current && !items.some((item) => item.value === current)) {
		items.push({
			value: current,
			label: current,
			description: "current selection (unavailable)",
		});
	}

	return fromPromise(() =>
		ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
			const input = new Input({ placeholder: "type to filter models" });
			input.focused = true;
			let list: SelectList | undefined;
			let query = "";
			const container = new Container();

			const rebuild = () => {
				container.clear();
				container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
				container.addChild(new Text(theme.fg("accent", theme.bold(title))));
				container.addChild(input);
				const filtered = query ? fuzzyFilter(items, query, (item) => `${item.value} ${item.description ?? ""}`) : items;
				list = new SelectList(filtered, 12, getSelectListTheme());
				list.onSelect = (item) => done(item.value);
				list.onCancel = () => done(undefined);
				container.addChild(list);
				container.addChild(
					new Text(theme.fg("dim", `${filtered.length} model(s) • ↑↓ move • enter select • esc cancel`), 1, 0),
				);
				container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
			};
			rebuild();

			return {
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
						done(undefined);
						return;
					}
					if (matchesKey(data, "enter") || matchesKey(data, "return")) {
						list?.handleInput(data);
						return;
					}
					if (
						matchesKey(data, "up") ||
						matchesKey(data, "down") ||
						matchesKey(data, "pageUp") ||
						matchesKey(data, "pageDown")
					) {
						list?.handleInput(data);
						tui.requestRender();
						return;
					}
					input.handleInput(data);
					const next = input.getValue();
					if (next !== query) {
						query = next;
						rebuild();
					}
					tui.requestRender();
				},
			};
		}),
	);
}

export function editMode(
	ctx: ExtensionContext,
	engine: ModeEngine,
	store: ModeStore,
	initialName: string,
): Effect.Effect<void, unknown> {
	return Effect.gen(function* () {
		if (!ctx.hasUI) return;
		let name = initialName;
		for (;;) {
			const mode = store.get(name);
			if (!mode) return;
			const options = [
				`Enabled: ${mode.enabled ? "yes" : "no"}`,
				`Colour: ${colorLabel(mode.color)}`,
				`Tools: ${describeTools(mode.tools)}`,
				`Model: ${mode.model ?? "(default)"}`,
				`Thinking: ${mode.thinking ?? "(default)"}`,
				`Subagent model: ${mode.subagentModel ?? "(default)"}`,
				`Subagent thinking: ${mode.subagentThinking ?? "(default)"}`,
				`Instructions: ${mode.instructions ? `${mode.instructions.split("\n").length} line(s)` : "(none)"}`,
				`Description: ${mode.description ?? "(none)"}`,
				"Rename…",
				"Done",
			];
			const choice = yield* fromPromise(() => ctx.ui.select(`Edit mode "${name}"`, options));
			if (!choice) return;
			const index = options.indexOf(choice);
			let committed = true;

			switch (index) {
				case 0:
					mode.enabled = !mode.enabled;
					break;
				case 1: {
					const color = yield* pickColor(ctx, mode.color);
					if (color === undefined) committed = false;
					else mode.color = color || undefined;
					break;
				}
				case 2: {
					const tools = yield* pickTools(ctx, mode.tools);
					if (tools === undefined) committed = false;
					else mode.tools = tools;
					break;
				}
				case 3: {
					const model = yield* pickModel(ctx, `Model for "${name}"`, mode.model);
					if (model === undefined) {
						committed = false;
						break;
					}
					if (!model) {
						mode.model = undefined;
						mode.thinking = undefined;
						break;
					}
					const thinking = yield* pickThinking(
						ctx,
						`Effort for "${name}" (${model})`,
						mode.thinking,
						resolveModel(ctx, model),
					);
					if (thinking === undefined) {
						committed = false;
						break;
					}
					mode.model = model;
					mode.thinking = thinking || undefined;
					break;
				}
				case 4: {
					const thinking = yield* pickThinking(
						ctx,
						`Thinking for "${name}"`,
						mode.thinking,
						resolveModel(ctx, mode.model),
					);
					if (thinking === undefined) committed = false;
					else mode.thinking = thinking || undefined;
					break;
				}
				case 5: {
					const model = yield* pickModel(ctx, `Subagent model for "${name}"`, mode.subagentModel);
					if (model === undefined) {
						committed = false;
						break;
					}
					if (!model) {
						mode.subagentModel = undefined;
						mode.subagentThinking = undefined;
						break;
					}
					const thinking = yield* pickThinking(
						ctx,
						`Subagent effort for "${name}" (${model})`,
						mode.subagentThinking,
						resolveModel(ctx, model),
					);
					if (thinking === undefined) {
						committed = false;
						break;
					}
					mode.subagentModel = model;
					mode.subagentThinking = thinking || undefined;
					break;
				}
				case 6: {
					const thinking = yield* pickThinking(
						ctx,
						`Subagent thinking for "${name}"`,
						mode.subagentThinking,
						resolveModel(ctx, mode.subagentModel),
					);
					if (thinking === undefined) committed = false;
					else mode.subagentThinking = thinking || undefined;
					break;
				}
				case 7: {
					const text = yield* fromPromise(() =>
						ctx.ui.editor(`Instructions for mode "${name}"`, mode.instructions ?? ""),
					);
					if (text === undefined) committed = false;
					else mode.instructions = text.trim() ? text : undefined;
					break;
				}
				case 8: {
					const text = yield* fromPromise(() => ctx.ui.input("Mode description (optional)", mode.description ?? ""));
					if (text === undefined) committed = false;
					else mode.description = text.trim() || undefined;
					break;
				}
				case 9: {
					const renamed = yield* renameMode(ctx, store, name);
					if (!renamed) committed = false;
					else {
						if (engine.activeName === name) yield* engine.switchTo(renamed, ctx, { persist: false });
						name = renamed;
						committed = false;
					}
					break;
				}
				default:
					return;
			}

			if (!committed) continue;
			store.upsert(mode);
			store.save();
			if (engine.activeName === name) yield* engine.reapply(ctx);
		}
	});
}

export function standaloneEditPicker(
	ctx: ExtensionContext,
	store: ModeStore,
): Effect.Effect<string | undefined, unknown> {
	const names = store.names();
	if (names.length === 0) return Effect.succeed(undefined);
	if (names.length === 1) return Effect.succeed(names[0]);
	return fromPromise(() => ctx.ui.select("Edit which mode?", names));
}
