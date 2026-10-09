import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { ModeEngine } from "./engine.ts";
import type { ModeStore } from "./store.ts";
import type { Mode } from "./types.ts";

function setup(mode?: Mode) {
	const originalModel = { provider: "p", id: "original" } as Model<any>;
	const targetModel = { provider: "p", id: "target" } as Model<any>;
	const calls: { model?: Model<any>; tools?: string[]; thinking?: string } = {};
	const pi = {
		getThinkingLevel: () => "high",
		getActiveTools: () => ["read", "write"],
		getAllTools: () => [{ name: "read" }, { name: "write" }],
		setModel: async (model: Model<any>) => {
			calls.model = model;
			return true;
		},
		setActiveTools: (tools: string[]) => {
			calls.tools = tools;
		},
		setThinkingLevel: (thinking: string) => {
			calls.thinking = thinking;
		},
		appendEntry: () => {},
		events: { emit: () => {} },
	} as unknown as ExtensionAPI;
	const ctx = {
		model: originalModel,
		modelRegistry: {
			find: (provider: string, id: string) => (provider === "p" && id === "target" ? targetModel : undefined),
		},
		mode: "rpc",
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setWorkingMessage: () => {},
			setWorkingIndicator: () => {},
			setWidget: () => {},
			getEditorComponent: () => undefined,
			notify: () => {},
		},
	} as unknown as ExtensionContext;
	const engine = new ModeEngine(pi);
	engine.setStore({
		get: (name: string) => (name === mode?.name ? mode : undefined),
	} as ModeStore);
	return { engine, ctx, calls, originalModel, targetModel };
}

describe("ModeEngine effects", () => {
	test("activation and restoration compose model, tools, and thinking changes", async () => {
		const mode: Mode = {
			name: "review",
			enabled: true,
			tools: ["read"],
			model: "p/target",
			thinking: "low",
		};
		const { engine, ctx, calls, originalModel, targetModel } = setup(mode);

		const activated = await Effect.runPromise(engine.activate("review", ctx));
		expect(activated).toEqual({ ok: true });
		expect(engine.activeName).toBe("review");
		expect(calls.model).toBe(targetModel);
		expect(calls.tools).toEqual(["read"]);
		expect(calls.thinking).toBe("low");

		await Effect.runPromise(engine.activate(undefined, ctx));
		expect(engine.activeName).toBeUndefined();
		expect(calls.model).toBe(originalModel);
		expect(calls.tools).toEqual(["read", "write"]);
		expect(calls.thinking).toBe("high");
	});

	test("unknown mode returns a result without changing current mode", async () => {
		const { engine, ctx } = setup({
			name: "review",
			enabled: true,
			tools: "default",
		});
		await Effect.runPromise(engine.activate("review", ctx));

		expect(await Effect.runPromise(engine.activate("missing", ctx))).toEqual({
			ok: false,
			message: 'Unknown mode "missing"',
		});
		expect(engine.activeName).toBe("review");
	});
});
