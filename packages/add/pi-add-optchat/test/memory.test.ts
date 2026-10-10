import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
  byteLength,
  dueScore,
  formatView,
  isSiblingPair,
  MemoryStore,
  mergeViewAt,
  nodeKey,
  pickMerge,
  splitMessage,
  type SummaryNode,
  type ViewNode,
} from "../src/memory.ts";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function storeAt(config: Partial<ConstructorParameters<typeof MemoryStore>[0]> = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-optchat-test-"));
  dirs.push(root);
  const store = new MemoryStore({ root, maxViewBytes: 400, targetViewBytes: 180, summaryBytes: 512, ...config });
  await Effect.runPromise(store.initialize());
  return store;
}

describe("memory format and merge scheduling", () => {
  test("splits by UTF-8 bytes without breaking code points", () => {
    const chunks = splitMessage("🙂".repeat(30), 20);
    expect(chunks.every((chunk) => byteLength(chunk) <= 20)).toBe(true);
    expect(chunks.join("")).toBe("🙂".repeat(30));
  });

  test("recognizes aligned sibling pairs and scores age in line units", () => {
    expect(isSiblingPair({ l: 0, i: 2 }, { l: 0, i: 3 })).toBe(true);
    expect(isSiblingPair({ l: 0, i: 1 }, { l: 0, i: 2 })).toBe(false);
    expect(dueScore({ l: 2, i: 0 }, 16)).toBe(2.25);
  });

  test("merges oldest equally-due built pairs first", () => {
    const view: ViewNode[] = [
      { l: 1, i: 0 },
      { l: 1, i: 2 },
      { l: 0, i: 4 },
      { l: 0, i: 5 },
    ];
    const built = new Set([nodeKey(2, 0), nodeKey(1, 4)]);
    expect(pickMerge(view, built, 6)).toBe(0);
    expect(mergeViewAt(view, 0)).toEqual({ l: 2, i: 0 });
  });

  test("renders missing summaries explicitly and removes line breaks", () => {
    const view = [{ l: 0, i: 0 }];
    const nodes = new Map([[nodeKey(0, 0), { l: 0, i: 0, text: "one\ntwo", size: 7 } satisfies SummaryNode]]);
    expect(formatView(view, nodes)).toContain("0+1|one two");
    expect(formatView([{ l: 1, i: 2 }], nodes)).toContain("2+2|(not summarized yet: zoom it)");
  });
});

describe("MemoryStore", () => {
  test("persists log, nodes, and view; zoom returns exact leaf messages", async () => {
    const store = await storeAt();
    await Effect.runPromise(store.append("user", "question"));
    await Effect.runPromise(store.append("unii", "answer"));
    await Effect.runPromise(store.addNode({ l: 1, i: 0, text: "Q and A", size: 7 }));
    await Effect.runPromise(store.saveView());
    expect(await Effect.runPromise(store.zoom(0, 2))).toContain("0+1|user: question");
    await Effect.runPromise(store.close());

    const resumed = new MemoryStore(store.config);
    await Effect.runPromise(resumed.initialize());
    expect(resumed.getMessageCount()).toBe(2);
    expect(await Effect.runPromise(resumed.zoom(0, 2))).toBe("0+1|user: question\n1+1|unii: answer");
    await Effect.runPromise(resumed.close());
  });

  test("repairs one unsummarized interrupted append but refuses larger gaps", async () => {
    const store = await storeAt();
    await Effect.runPromise(store.append("user", "x".repeat(513)));
    await Effect.runPromise(store.close());
    const resumed = new MemoryStore(store.config);
    await Effect.runPromise(resumed.initialize());
    expect(resumed.getReadyMessageIds()).toEqual([0]);
    await Effect.runPromise(resumed.close());
  });

  test("refuses second writer and refuses to reconstruct a missing view", async () => {
    const store = await storeAt();
    const contender = new MemoryStore(store.config);
    await expect(Effect.runPromise(contender.initialize())).rejects.toThrow("already has a writer");
    await Effect.runPromise(store.append("user", "persisted"));
    await Effect.runPromise(store.close());
    const { unlink } = await import("node:fs/promises");
    await unlink(join(store.config.root, "view.json"));
    const resumed = new MemoryStore(store.config);
    await expect(Effect.runPromise(resumed.initialize())).rejects.toThrow("refusing to rebuild");
  });

  test("rejects malformed zoom ranges and over-size summaries", async () => {
    const store = await storeAt();
    await expect(Effect.runPromise(store.zoom(1, 2))).rejects.toThrow("aligned");
    await Effect.runPromise(store.append("user", "x".repeat(513)));
    await expect(Effect.runPromise(store.addNode({ l: 0, i: 0, text: "x".repeat(513), size: 513 }))).rejects.toThrow("exceeds");
    await Effect.runPromise(store.close());
  });
});
