import assert from "node:assert/strict";
import test from "node:test";
import { configPath, discoveryPrompt } from "./index.ts";

test("discovery prompt carries the target config path", () => {
	const prompt = discoveryPrompt("/tmp/some-repo");
	assert.ok(prompt.includes("/tmp/some-repo"));
	assert.ok(prompt.includes(configPath("/tmp/some-repo")));
});

test("discovery prompt pins the config schema", () => {
	const prompt = discoveryPrompt("/tmp/some-repo");
	assert.ok(prompt.includes("{check, fileCheck?, enabled: true}"));
	assert.ok(prompt.includes("Keep the schema exactly as specified. Do not add fields."));
});

test("discovery prompt warns about the argv-direct shell-operator rule", () => {
	assert.ok(discoveryPrompt("/tmp/some-repo").includes("shell operator"));
});
