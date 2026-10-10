// Preflight guard for package manager scripts. Fatally errors on a Node
// version below the repo's engine floor so checks fail with an actionable
// message instead of a cryptic runtime error (e.g. node:fs missing globSync).
// Usage: node scripts/require-node.mjs
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const { engines } = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const spec = engines?.node;
if (!spec) process.exit(0);

// Parse a semver range into a single lower floor (supports >=x, >=x.y.z).
const floorMatch = spec.match(/>=?\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
if (!floorMatch) process.exit(0);
const floor = [Number(floorMatch[1]), Number(floorMatch[2] ?? 0), Number(floorMatch[3] ?? 0)];

const [major, minor, patch] = process.versions.node.split(".").map(Number);
const ok = major > floor[0] || (major === floor[0] && minor > floor[1]) || (major === floor[0] && minor === floor[1] && patch >= floor[2]);

if (!ok) {
	console.error(
		`\n  Node ${process.version} is too old for this repo.\n` +
		`  package.json requires node ${spec} (current: ${process.version}).\n` +
		`  Run the check with node >= 22.12, e.g. via mise:  mise exec -- pnpm run check\n`,
	);
	process.exit(1);
}