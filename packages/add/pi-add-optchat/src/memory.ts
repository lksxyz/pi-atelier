import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Effect } from "effect";

export const MESSAGE_LIMIT_BYTES = 30_000;
export const SUMMARY_LIMIT_BYTES = 512;
export const DEFAULT_VIEW_LIMIT_BYTES = 128_000;
export const DEFAULT_VIEW_TARGET_BYTES = 64_000;

export type MessageKind = "user" | "unii" | "tool" | "echo" | "work" | "note";

export interface MemoryMessage {
  i: number;
  kind: MessageKind;
  text: string;
  size: number;
  date: string;
}

export interface SummaryNode {
  l: number;
  i: number;
  text: string;
  size: number;
}

export interface ViewNode {
  l: number;
  i: number;
}

export interface MemoryConfig {
  root: string;
  maxViewBytes: number;
  targetViewBytes: number;
  summaryBytes: number;
  lockWriter?: boolean;
  readOnly?: boolean;
}

export interface MemoryToolModel {
  zoom(id: number, count: number): Effect.Effect<string>;
  date(id: number): Effect.Effect<string>;
}

export function createMemoryConfig(cwd: string, agentDir = join(homedir(), ".pi", "agent")): MemoryConfig {
  const projectRoot = resolve(cwd);
  const root = join(agentDir, "optchat", "projects", encodeURIComponent(projectRoot));
  return { root, maxViewBytes: DEFAULT_VIEW_LIMIT_BYTES, targetViewBytes: DEFAULT_VIEW_TARGET_BYTES, summaryBytes: SUMMARY_LIMIT_BYTES };
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function splitMessage(text: string, maxBytes = MESSAGE_LIMIT_BYTES): string[] {
  if (maxBytes < 4) throw new Error("maxBytes must be at least 4");
  const chunks: string[] = [];
  let chunk = "";
  let size = 0;
  for (const codePoint of text) {
    const charSize = byteLength(codePoint);
    if (size + charSize > maxBytes && chunk) {
      chunks.push(chunk);
      chunk = "";
      size = 0;
    }
    chunk += codePoint;
    size += charSize;
  }
  if (chunk || chunks.length === 0) chunks.push(chunk);
  return chunks;
}

export function formatView(view: readonly ViewNode[], nodes: ReadonlyMap<string, SummaryNode>): string {
  const lines = view.map(({ l, i }) => {
    const node = nodes.get(nodeKey(l, i));
    const end = i + 2 ** l;
    const text = node?.text ?? `(not summarized yet: zoom it)`;
    return `${i}+${end - i}|${text.replace(/\s+/g, " ")}`;
  });
  return `<chat>\n${lines.join("\n")}\n</chat>`;
}

export function nodeKey(level: number, id: number): string {
  return `${level}:${id}`;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function isSiblingPair(a: ViewNode, b: ViewNode): boolean {
  const size = 2 ** a.l;
  return a.l === b.l && a.i + size === b.i && a.i % (size * 2) === 0;
}

export function dueScore(pair: ViewNode, messageCount: number): number {
  const last = pair.i + 2 ** (pair.l + 1) - 1;
  return (messageCount - last) / (2 ** pair.l);
}

export function pickMerge(
  view: readonly ViewNode[],
  built: ReadonlySet<string>,
  messageCount: number,
): number | undefined {
  let winner: number | undefined;
  let highest = Number.NEGATIVE_INFINITY;
  for (let index = 0; index + 1 < view.length; index++) {
    const left = view[index];
    const right = view[index + 1];
    if (!left || !right || !isSiblingPair(left, right)) continue;
    if (!built.has(nodeKey(left.l + 1, left.i))) continue;
    const due = dueScore(left, messageCount);
    if (due > highest) {
      winner = index;
      highest = due;
    }
  }
  return winner;
}

export function mergeViewAt(view: ViewNode[], index: number): ViewNode {
  const left = view[index];
  const right = view[index + 1];
  if (!left || !right || !isSiblingPair(left, right)) throw new Error("view entries are not mergeable siblings");
  const parent = { l: left.l + 1, i: left.i };
  view.splice(index, 2, parent);
  return parent;
}

export function chooseMessageKind(message: unknown): MessageKind | undefined {
  if (!message || typeof message !== "object") return undefined;
  const candidate = message as { role?: unknown; customType?: unknown; content?: unknown; toolName?: unknown; name?: unknown };
  if (candidate.role === "user") return "user";
  if (candidate.role === "assistant") {
    const content = Array.isArray(candidate.content) ? candidate.content : [];
    return content.some((part) => !!part && typeof part === "object" && (part as { type?: unknown }).type === "toolCall") ? "tool" : "unii";
  }
  if (candidate.role === "toolResult") return "echo";
  if (candidate.customType === "optchat-work") return "work";
  if (candidate.customType === "optchat-note") return "note";
  return undefined;
}

export function messageText(message: unknown): string {
  if (!message || typeof message !== "object") return String(message ?? "");
  const value = message as { role?: unknown; content?: unknown; toolName?: unknown; toolCallId?: unknown; customType?: unknown; details?: unknown };
  const parts: string[] = [];
  if (value.role === "assistant" && Array.isArray(value.content)) {
    for (const item of value.content) {
      if (!item || typeof item !== "object") continue;
      const part = item as { type?: unknown; text?: unknown; name?: unknown; arguments?: unknown };
      if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
      if (part.type === "toolCall") parts.push(`${String(part.name ?? "tool")} ${JSON.stringify(part.arguments ?? {})}`);
    }
  } else if (typeof value.content === "string") {
    parts.push(value.content);
  } else if (Array.isArray(value.content)) {
    for (const item of value.content) {
      if (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string") parts.push((item as { text: string }).text);
    }
  }
  if (value.role === "toolResult") parts.unshift(`${String(value.toolName ?? "tool")} result`);
  if (value.customType) parts.unshift(`[${String(value.customType)}]`);
  if (value.details !== undefined && value.role === undefined) parts.push(JSON.stringify(value.details));
  const text = parts.join("\n");
  if (value.role !== "toolResult" || byteLength(text) <= MESSAGE_LIMIT_BYTES) return text;
  const bytes = Buffer.from(text, "utf8");
  const head = bytes.subarray(0, 15_000).toString("utf8").replace(/\uFFFD+$/g, "");
  const tail = bytes.subarray(bytes.length - 15_000).toString("utf8").replace(/^\uFFFD+/g, "");
  return `${head}\n…[tool output clipped]…\n${tail}`;
}

export class MemoryStore {
  readonly config: MemoryConfig;
  private readonly messages = new Map<number, MemoryMessage>();
  private readonly nodes = new Map<string, SummaryNode>();
  private view: ViewNode[] = [];
  private nextId = 0;
  private initialized = false;
  private loaded = false;
  private lockHandle: Awaited<ReturnType<typeof open>> | undefined;

  constructor(config: MemoryConfig) {
    this.config = config;
  }

  initialize() {
    return Effect.tryPromise({
      try: async () => {
        if (this.initialized) return;
        await mkdir(this.config.root, { recursive: true });
        if (this.config.lockWriter !== false && !this.config.readOnly) {
          const lockPath = join(this.config.root, "writer.lock");
          try {
            this.lockHandle = await open(lockPath, "wx");
            await this.lockHandle.writeFile(`${process.pid}\n`);
            await this.lockHandle.sync();
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            const owner = await readFile(lockPath, "utf8").catch(() => "");
            const pid = Number(owner.trim());
            if (!Number.isSafeInteger(pid) || pid <= 0 || processIsAlive(pid)) throw new Error(`OptChat memory already has a writer: ${this.config.root}`);
            await rm(lockPath, { force: true });
            this.lockHandle = await open(lockPath, "wx");
            await this.lockHandle.writeFile(`${process.pid}\n`);
            await this.lockHandle.sync();
          }
        }
        try {
          if (!this.loaded) {
            await this.load();
            this.loaded = true;
          }
          this.initialized = true;
        } catch (error) {
          await this.releaseLock();
          throw error;
        }
      },
      catch: (error) => error,
    });
  }

  close() {
    return Effect.tryPromise({ try: () => this.releaseLock(), catch: (error) => error });
  }

  append(kind: MessageKind, text: string, date = new Date().toISOString()) {
    return Effect.tryPromise({
      try: async () => {
        this.assertInitialized();
        if (this.config.readOnly) throw new Error("OptChat memory store is read-only");
        const chunks = splitMessage(text);
        const records: MemoryMessage[] = [];
        for (const chunk of chunks) {
          const message: MemoryMessage = { i: this.nextId++, kind, text: chunk, size: byteLength(chunk), date };
          await this.appendJsonLine(this.messagePath(date), message);
          this.messages.set(message.i, message);
          this.view.push({ l: 0, i: message.i });
          if (message.size <= this.config.summaryBytes) {
            const leaf = { l: 0, i: message.i, text: message.text, size: message.size };
            await this.appendJsonLine(this.nodePath(message.i), leaf);
            this.nodes.set(nodeKey(0, message.i), leaf);
          }
          records.push(message);
        }
        return records;
      },
      catch: (error) => error,
    });
  }

  addNode(node: SummaryNode) {
    return Effect.tryPromise({
      try: async () => {
        this.assertInitialized();
        if (this.config.readOnly) throw new Error("OptChat memory store is read-only");
        if (this.nodes.has(nodeKey(node.l, node.i))) throw new Error(`summary node already built: ${nodeKey(node.l, node.i)}`);
        const expected = node.l === 0
          ? this.messages.has(node.i)
          : this.nodes.has(nodeKey(node.l - 1, node.i)) && this.nodes.has(nodeKey(node.l - 1, node.i + 2 ** (node.l - 1)));
        if (!expected) throw new Error(`missing source node for ${nodeKey(node.l, node.i)}`);
        if (byteLength(node.text) > this.config.summaryBytes) throw new Error(`summary exceeds ${this.config.summaryBytes} UTF-8 bytes`);
        const record = { ...node, size: byteLength(node.text) };
        await this.appendJsonLine(this.nodePath(record.i), record);
        this.nodes.set(nodeKey(record.l, record.i), record);
        return record;
      },
      catch: (error) => error,
    });
  }

  saveView() {
    return Effect.tryPromise({
      try: async () => {
        this.assertInitialized();
        if (this.config.readOnly) throw new Error("OptChat memory store is read-only");
        await this.atomicWrite(join(this.config.root, "view.json"), `${JSON.stringify(this.view)}\n`);
      },
      catch: (error) => error,
    });
  }

  appendAndSaveView(kind: MessageKind, text: string, date?: string) {
    const store = this;
    return Effect.gen(function* () {
      const records = yield* store.append(kind, text, date);
      yield* store.saveView();
      return records;
    });
  }

  mergeOne() {
    return Effect.tryPromise({
      try: async () => {
        if (this.config.readOnly) throw new Error("OptChat memory store is read-only");
        const index = pickMerge(this.view, new Set(this.nodes.keys()), this.nextId);
        if (index === undefined) return undefined;
        const parent = mergeViewAt(this.view, index);
        await this.atomicWrite(join(this.config.root, "view.json"), `${JSON.stringify(this.view)}\n`);
        return parent;
      },
      catch: (error) => error,
    });
  }

  mergeToTarget() {
    const store = this;
    return Effect.gen(function* () {
      while (store.viewBytes() > store.config.targetViewBytes) {
        const merged = yield* store.mergeOne();
        if (!merged) break;
      }
      return store.viewBytes();
    });
  }

  viewBytes(): number {
    return byteLength(formatView(this.view, this.nodes));
  }

  renderView(endAt = this.nextId): string {
    return formatView(this.getViewNodes(endAt), this.nodes);
  }

  getViewNodes(endAt = this.nextId): ViewNode[] {
    const clipped: ViewNode[] = [];
    for (const node of this.view) {
      if (node.i + 2 ** node.l > endAt || !this.nodes.has(nodeKey(node.l, node.i))) break;
      clipped.push({ ...node });
    }
    return clipped;
  }

  renderViewLines(endAt = this.nextId): string[] {
    return this.getViewNodes(endAt).map(({ l, i }) => {
      const node = this.nodes.get(nodeKey(l, i));
      return `${i}+${2 ** l}|${(node?.text ?? "(not summarized yet: zoom it)").replace(/\s+/g, " ")}`;
    });
  }

  getMessage(id: number): MemoryMessage | undefined {
    return this.messages.get(id);
  }

  getMessageIds(): number[] {
    return [...this.messages.keys()].sort((a, b) => a - b);
  }

  getNode(level: number, id: number): SummaryNode | undefined {
    return this.nodes.get(nodeKey(level, id));
  }

  getView(): readonly ViewNode[] {
    return this.view.map((node) => ({ ...node }));
  }

  getMessageCount(): number {
    return this.nextId;
  }

  getUnbuiltMessageIds(): number[] {
    return this.getMessageIds().filter((id) => !this.nodes.has(nodeKey(0, id)));
  }

  getReadyMessageIds(): number[] {
    return this.getUnbuiltMessageIds().slice(0, 8);
  }

  search(query: string, limit = 10): string {
    const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return "No search terms provided";
    const results = [...this.messages.values()]
      .map((message) => ({
        message,
        score: terms.reduce((score, term) => score + (message.text.toLocaleLowerCase().includes(term) ? 1 : 0), 0),
      }))
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score || b.message.i - a.message.i)
      .slice(0, Math.max(1, Math.min(20, Math.floor(limit))));
    if (results.length === 0) return `No memory messages match: ${query}`;
    return results.map(({ message, score }) => `${message.i}+1|${message.kind} (${message.date}, score ${score}): ${message.text.slice(0, 240)}`).join("\n");
  }

  zoom(id: number, count: number): Effect.Effect<string, unknown> {
    return Effect.tryPromise({ try: () => this.zoomInternal(id, count), catch: (error) => error });
  }

  date(id: number): Effect.Effect<string, unknown> {
    return Effect.sync(() => this.messages.get(id)?.date ?? `No message ${id}`);
  }

  private async zoomInternal(id: number, count: number): Promise<string> {
    this.assertInitialized();
    if (!Number.isSafeInteger(id) || !Number.isSafeInteger(count) || count < 1 || (count & (count - 1)) !== 0 || id < 0 || id % count !== 0) {
      throw new Error("zoom requires non-negative id and power-of-two count aligned to count");
    }
    if (count === 1) {
      const message = this.messages.get(id);
      if (!message) return `No message ${id}`;
      return `${id}+1|${message.kind}: ${message.text}`;
    }
    const level = Math.log2(count);
    const node = this.nodes.get(nodeKey(level, id));
    if (!node) return `Summary ${id}+${count} is not built yet`;
    const half = count / 2;
    const left = await this.zoomInternal(id, half);
    const right = await this.zoomInternal(id + half, half);
    return `${left}\n${right}`;
  }

  private async load(): Promise<void> {
    const messageFiles = await this.listFiles(join(this.config.root, "main"));
    const nodeFiles = await this.listFiles(join(this.config.root, "tree"));
    for (const file of messageFiles) {
      const rows = await this.readJsonLines<MemoryMessage>(file);
      for (const message of rows) {
        if (!Number.isSafeInteger(message.i) || message.i < 0 || message.size !== byteLength(message.text) || this.messages.has(message.i)) throw new Error(`invalid or duplicate message record in ${file}`);
        this.messages.set(message.i, message);
        this.nextId = Math.max(this.nextId, message.i + 1);
      }
    }
    for (const file of nodeFiles) {
      const rows = await this.readJsonLines<SummaryNode>(file);
      for (const node of rows) {
        if (!Number.isSafeInteger(node.l) || node.l < 0 || !Number.isSafeInteger(node.i) || node.i < 0 || node.i % (2 ** node.l) !== 0 || node.size !== byteLength(node.text) || this.nodes.has(nodeKey(node.l, node.i))) throw new Error(`invalid or duplicate summary record in ${file}`);
        this.nodes.set(nodeKey(node.l, node.i), node);
      }
    }
    let viewContent: string;
    try {
      viewContent = await readFile(join(this.config.root, "view.json"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (this.messages.size > 0) throw new Error("OptChat view is missing while message logs exist; refusing to rebuild and invalidate cache-stable history");
      this.view = [];
      if (!this.config.readOnly) await this.atomicWrite(join(this.config.root, "view.json"), `${JSON.stringify(this.view)}\n`);
      return;
    }
    const saved = JSON.parse(viewContent) as unknown;
    if (!Array.isArray(saved) || saved.some((node) => !node || !Number.isSafeInteger(node.l) || node.l < 0 || !Number.isSafeInteger(node.i) || node.i < 0)) throw new Error("invalid view file");
    this.view = saved as ViewNode[];
    this.validateView();
    const covered = this.view.at(-1);
    const nextUncoveredId = covered ? covered.i + 2 ** covered.l : 0;
    if (this.nextId - nextUncoveredId > 8) throw new Error("OptChat view has more than 8 unsummarized messages; refusing to expose a partial user turn");
    for (let id = nextUncoveredId; id < this.nextId; id++) this.view.push({ l: 0, i: id });
    if (nextUncoveredId < this.nextId && !this.config.readOnly) await this.atomicWrite(join(this.config.root, "view.json"), `${JSON.stringify(this.view)}\n`);
  }

  private validateView(): void {
    let previousEnd = 0;
    for (const node of this.view) {
      const size = 2 ** node.l;
      if (!Number.isSafeInteger(size) || node.i % size !== 0 || node.i < previousEnd || node.i + size > this.nextId) throw new Error("OptChat view is not a valid chronological partition");
      previousEnd = node.i + size;
    }
    if (this.nextId - previousEnd > 8) throw new Error("OptChat view has more than 8 unsummarized messages; refusing to expose a partial user turn");
  }

  private async appendJsonLine(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const handle = await open(path, "a");
    try {
      await handle.write(`${JSON.stringify(value)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async atomicWrite(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`;
    try {
      await writeFile(temp, content, "utf8");
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async readJsonLines<T>(path: string): Promise<T[]> {
    const content = await readFile(path, "utf8");
    return content.split("\n").filter(Boolean).map((line) => JSON.parse(line) as T);
  }

  private async listFiles(path: string): Promise<string[]> {
    const { readdir } = await import("node:fs/promises");
    try {
      return (await readdir(path)).sort().map((name) => join(path, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private messagePath(date: string): string {
    return join(this.config.root, "main", `${date.slice(0, 10)}.jsonl`);
  }

  private nodePath(id: number): string {
    const date = this.messages.get(id)?.date ?? new Date().toISOString();
    return join(this.config.root, "tree", `${date.slice(0, 10)}.jsonl`);
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error("OptChat memory store is not initialized");
  }

  private async releaseLock(): Promise<void> {
    if (this.lockHandle) {
      const lockPath = join(this.config.root, "writer.lock");
      const owner = await readFile(lockPath, "utf8").catch(() => "");
      if (Number(owner.trim()) === process.pid) await rm(lockPath, { force: true });
      await this.lockHandle.close();
      this.lockHandle = undefined;
    }
    this.initialized = false;
  }
}
