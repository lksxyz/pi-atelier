/**
 * pi-vision core — pure logic, no pi imports. Runs under plain `bun` for self-checks.
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import { Cause, Effect, Exit, Option } from "effect";

export const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // guard for the raw fallback path

const DEFAULT_PROMPT = `Describe this image as text for a text-only LLM that must act on it. Compact but complete:
- What it is (screenshot, photo, diagram, chart, UI, terminal output)
- ALL visible text verbatim (error messages, code, labels, values, button names)
- Layout: sections, order, highlighted/selected/clickable elements, states (on/off, empty/full, enabled/disabled)
- Numbers, colors, icons, and anything that changes meaning if omitted
Plain text with markdown structure, no preamble.`;

export interface VisionConfig {
  /** Raw mode: any OpenAI-compatible endpoint (keep as-is). */
  baseUrl?: string;
  apiKey?: string;
  /** Registry mode: pi-registered provider id (models.json / /login). */
  provider?: string;
  /** Model id: raw mode = gateway model id; registry mode = model id under provider. */
  model: string;
  prompt: string;
  maxTokens: number;
}

export let configPath = join(homedir(), ".pi", "pi-vision.json");
let cfgCache: VisionConfig | null = null;

export function setConfigPath(path: string | null) {
  configPath = path ?? join(homedir(), ".pi", "pi-vision.json");
  resetConfigCache();
}

export function resetConfigCache() {
  cfgCache = null;
}

/** Merge partial config into the config file. Returns merged config. */
export function saveConfig(partial: Partial<VisionConfig>): VisionConfig {
  let existing: Partial<VisionConfig> = {};
  try {
    existing = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    // no file yet
  }
  const merged = { ...existing, ...partial } as VisionConfig;
  // Raw (baseUrl/apiKey) and registry (provider) modes are mutually exclusive:
  // setting one drops the other, so a lingering `provider` key can't silently flip
  // `/pi-vision set baseUrl=...` into registry mode (and vice-versa).
  if (partial.baseUrl !== undefined || partial.apiKey !== undefined) delete merged.provider;
  if (partial.provider !== undefined) {
    delete merged.baseUrl;
    delete merged.apiKey;
  }
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(merged, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(configPath, 0o600);
  } catch {
    // mode may already be restrictive
  }
  resetConfigCache();
  return loadConfig();
}

export function loadConfig(): VisionConfig {
  if (cfgCache) return cfgCache;
  let file: Partial<VisionConfig> = {};
  try {
    file = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    // no config file — env vars only
  }
  const env = process.env;
  const maxTokens = file.maxTokens ?? 1500;
  cfgCache = {
    baseUrl: file.baseUrl ?? env.PI_VISION_BASE_URL ?? "",
    apiKey: file.apiKey ?? env.PI_VISION_API_KEY ?? "",
    provider: file.provider ?? env.PI_VISION_PROVIDER ?? undefined,
    model: file.model ?? env.PI_VISION_MODEL ?? "",
    prompt: file.prompt ?? DEFAULT_PROMPT,
    // hand-edited JSON may carry a bogus maxTokens — same check as the CLI
    maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 1500,
  };
  return cfgCache;
}

export function modelSupportsImages(model?: { input?: string[] }): boolean {
  return !!model?.input?.includes("image");
}

/**
 * Retry backoff that rejects immediately when `signal` aborts. The abort listener
 * is removed in `finally`, so it never leaks after the wait completes or aborts.
 */
const sleep = (ms: number, signal?: AbortSignal): Effect.Effect<void, Error> => {
  if (!signal) return Effect.sleep(ms);
  return Effect.callback<void, Error>((resume) => {
    if (signal.aborted) return resume(Effect.fail(new Error("pi-vision: aborted during retry")));
    const timer = setTimeout(() => resume(Effect.void), ms);
    const onAbort = () => {
      clearTimeout(timer);
      resume(Effect.fail(new Error("pi-vision: aborted during retry")));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    return Effect.sync(() => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    });
  });
};

/**
 * Send already-encoded base64 image to the vision API.
 * Used with pi's own resized output from the built-in read tool.
 * `model` may be a comma-separated chain (try in order). Transient errors (408/429/5xx)
 * get one retry; per-model failures fall through to the next model.
 */
const asError = (cause: unknown): Error => cause instanceof Error ? cause : new Error(String(cause));
const promise = <A>(try_: (signal: AbortSignal) => PromiseLike<A>) =>
  Effect.tryPromise({ try: try_, catch: asError });

export const describeBase64 = Effect.fnUntraced(function* (
  data: string,
  mimeType: string,
  cfg: VisionConfig,
  signal?: AbortSignal,
  extraHeaders?: Record<string, string>,
): Effect.fn.Return<{ text: string; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } } }, Error> {
  const models = cfg.model.split(",").map((m) => m.trim()).filter(Boolean);
  if (models.length === 0) return yield* Effect.fail(new Error("pi-vision: no model configured"));
  let lastErr: Error | null = null;
  for (const model of models) {
    const exit = yield* Effect.exit(describeOnce(data, mimeType, { ...cfg, model }, signal, extraHeaders));
    if (Exit.isSuccess(exit)) return exit.value;
    const error = Cause.findErrorOption(exit.cause);
    lastErr = Option.isSome(error) ? asError(error.value) : asError(Cause.squash(exit.cause));
  }
  return yield* Effect.fail(lastErr ?? new Error("pi-vision: vision call failed"));
});

const describeOnce = Effect.fnUntraced(function* (
  data: string,
  mimeType: string,
  cfg: VisionConfig,
  signal?: AbortSignal,
  extraHeaders?: Record<string, string>,
): Effect.fn.Return<{ text: string; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } } }, Error> {
  const key = cacheKey(data, cfg);
  const cached = cacheGet(key);
  if (cached !== undefined) return { text: cached };

  const body = JSON.stringify({
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    stream: false,
    messages: [{ role: "user", content: [
      { type: "text", text: cfg.prompt },
      { type: "image_url", image_url: { url: `data:${mimeType};base64,${data}` } },
    ] }],
  });
  const attempt = promise((effectSignal) => {
    const timeoutSignal = AbortSignal.timeout(60_000);
    const combined = AbortSignal.any([effectSignal, ...(signal ? [signal] : []), timeoutSignal]);
    return fetch(`${(cfg.baseUrl ?? "").replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      signal: combined,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.apiKey}`,
        ...(extraHeaders ?? {}),
      },
      body,
    });
  });

  let res = yield* attempt;
  if (!res.ok && (res.status === 408 || res.status === 429 || res.status >= 500)) {
    const bodyText = yield* promise(() => res.text()).pipe(Effect.catch(() => Effect.succeed("")));
    const waitMs = res.status === 429 ? retryAfterMs(res.headers.get("retry-after"), bodyText) : 1500;
    yield* sleep(waitMs, signal);
    res = yield* attempt;
  }
  if (!res.ok) {
    const responseText = yield* promise(() => res.text()).pipe(Effect.catch(() => Effect.succeed("")));
    const redacted = responseText.replace(/Bearer\\s+\\S+/gi, "Bearer ***").replace(/(authorization\\s*[:=]\\s*)[^\\s,;]+/gi, "$1***");
    return yield* Effect.fail(new Error(`pi-vision: vision API ${res.status}${cfg.model !== "" ? ` (${cfg.model})` : ""}: ${redacted.slice(0, 300)}`));
  }
  const dataJson = yield* promise(() => res.json() as Promise<{
    choices?: { message?: { content?: unknown } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  }>);
  const text = dataJson?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) return yield* Effect.fail(new Error("pi-vision: unexpected or empty API response"));
  cacheSet(key, text);
  return {
    text,
    usage: dataJson.usage && typeof dataJson.usage.prompt_tokens === "number"
      ? {
          input: dataJson.usage.prompt_tokens,
          output: dataJson.usage.completion_tokens ?? 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: (dataJson.usage.prompt_tokens ?? 0) + (dataJson.usage.completion_tokens ?? 0),
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        }
      : undefined,
  };
});

/**
 * Raw fallback (no pi resize): read an image file and base64-encode it,
 * guarding file size. Used when pi's image processing failed.
 */
export const readRawImage = Effect.fnUntraced(function* (
  path: string,
): Effect.fn.Return<{ data: string; mimeType: string }, Error> {
  const mimeType = MIME[extname(path).toLowerCase()];
  if (!mimeType) return yield* Effect.fail(new Error(`pi-vision: unsupported image type "${extname(path)}"`));
  const info = yield* promise(() => stat(path)).pipe(Effect.catch(() => Effect.succeed(null)));
  if (info && info.size > MAX_IMAGE_BYTES) {
    return yield* Effect.fail(new Error(`pi-vision: image too large (${(info.size / 1048576).toFixed(1)}MB > 20MB). Downscale it first.`));
  }
  const bytes = yield* promise(() => readFile(path));
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    return yield* Effect.fail(new Error(`pi-vision: image too large (${(bytes.byteLength / 1048576).toFixed(1)}MB > 20MB). Downscale it first.`));
  }
  return { data: Buffer.from(bytes).toString("base64"), mimeType };
});

export const describeRawFile = Effect.fnUntraced(function* (
  path: string,
  cfg: VisionConfig,
  signal?: AbortSignal,
): Effect.fn.Return<{ text: string; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } } }, Error> {
  const { data, mimeType } = yield* readRawImage(path);
  return yield* describeBase64(data, mimeType, cfg, signal);
});

export function maskKey(key: string): string {
  if (!key) return "(not set)";
  return key.length <= 8 ? "***" : `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/** Tokenize args, respecting double quotes (key="a b c" = one token). */
function tokenize(args: string): string[] {
  const out: string[] = [];
  const re = /([^\s=]+)="([^"]*)"|"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(args))) {
    if (m[1]) out.push(`${m[1]}=${m[2]}`);
    else out.push(m[3] ?? m[4]);
  }
  return out;
}

/** Parse "k=v k2=v2" args into a partial config. Throws on unknown keys. */
export function parseArgs(args: string): { action: "set" | "show" | "reset"; values: Partial<VisionConfig> } {
  const tokens = tokenize(args);
  if (tokens.length === 0 || tokens[0] === "show" || tokens[0] === "status") return { action: "show", values: {} };
  if (tokens[0] === "reset") return { action: "reset", values: {} };
  if (tokens[0] !== "set") {
    throw new Error(`Unknown action "${tokens[0]}". Usage: /pi-vision [set key=value ...| show | reset]`);
  }
  const values: Partial<VisionConfig> = {};
  for (const tok of tokens.slice(1)) {
    const eq = tok.indexOf("=");
    if (eq <= 0) throw new Error(`Expected key=value, got "${tok}"`);
    const key = tok.slice(0, eq) as keyof VisionConfig;
    let value = tok.slice(eq + 1);
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (!["baseUrl", "apiKey", "provider", "model", "prompt", "maxTokens"].includes(key)) {
      throw new Error(`Unknown setting "${key}". Known: baseUrl, apiKey, provider, model, prompt, maxTokens`);
    }
    if (key === "maxTokens") {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`maxTokens must be a positive number, got "${value}"`);
      values[key] = n;
    } else {
      values[key] = value;
    }
  }
  return { action: "set", values };
}

/**
 * 429 backoff: Retry-After header (seconds), or "reset after Xs"/"X seconds" in the body.
 * Capped at 30s so a rate-limited read degrades to the placeholder instead of stalling.
 */
export function retryAfterMs(header: string | null, body: string): number {
  const cap = 30_000;
  if (header) {
    const s = Number(header.trim());
    if (Number.isFinite(s) && s > 0) return Math.min(s * 1000, cap);
  }
  const m = body.match(/reset after\s+(\d+)\s*s/i) ?? body.match(/(\d+)\s*(?:seconds|s)\b/i);
  if (m) {
    const s = Number(m[1]);
    if (Number.isFinite(s) && s > 0) return Math.min(s * 1000, cap);
  }
  return 1500;
}

export function isConfigComplete(cfg: VisionConfig): boolean {
  if (cfg.provider) return !!cfg.provider && !!cfg.model;
  return !!cfg.baseUrl && !!cfg.apiKey && !!cfg.model;
}

// --- description cache -------------------------------------------------------
// Content-addressed (sha1 of image bytes + model + baseUrl), LRU in memory,
// lazily persisted to disk so repeat reads across sessions are instant.

const CACHE_MAX = 200;
let cachePath = join(homedir(), ".pi", "pi-vision-cache.json");
let cache = new Map<string, string>();
let cacheLoaded = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

export function setCachePath(path: string | null) {
  cachePath = path ?? join(homedir(), ".pi", "pi-vision-cache.json");
  cacheLoaded = false;
}

export function clearCache() {
  cache.clear();
  cacheLoaded = false; // next access re-reads disk (may be empty — fine)
}

export function cacheSize(): number {
  return cache.size;
}

function loadCache() {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const raw = JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, string>;
    const entries = Object.entries(raw);
    // keep the last CACHE_MAX (JSON object order = insertion order for string keys)
    for (const [k, v] of entries.slice(-CACHE_MAX)) cache.set(k, v);
  } catch {
    // no cache yet or corrupt — start empty
  }
}

function persistCache() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, JSON.stringify(Object.fromEntries(cache)), { mode: 0o600 });
    } catch {
      // cache is best-effort
    }
  }, 1000);
}

export function cacheKey(data: string, cfg: VisionConfig): string {
  return createHash("sha1").update(`${cfg.baseUrl}|${cfg.model}|${cfg.prompt ?? ""}|${cfg.maxTokens ?? ""}|${data}`).digest("hex");
}

export function cacheGet(key: string): string | undefined {
  loadCache();
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key); // LRU touch
    cache.set(key, hit);
  }
  return hit;
}

export function cacheSet(key: string, text: string) {
  loadCache();
  cache.delete(key);
  cache.set(key, text);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  persistCache();
}
