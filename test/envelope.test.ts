import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChatRequest, buildDevSessionRequest } from "../src/core/envelope.js";

test("dev-session request advertises range reads only for a capable host", () => {
  const base = { task: "inspect", capabilities: ["read_file"], protocolVersion: 1 };
  assert.equal(buildDevSessionRequest(base).read_file_ranges, undefined);
  assert.equal(buildDevSessionRequest({ ...base, readFileRanges: true }).read_file_ranges, true);
});

test("buildChatRequest nulls empty model/agent and defaults to auto", () => {
  assert.deepEqual(buildChatRequest({ prompt: "hi", manualModel: false }), {
    query: "hi",
    forced_model_key: null,
    agent_name: null,
    model_pick_source: "auto",
  });
});

test("manual pick with a model sets model_pick_source manual", () => {
  assert.deepEqual(
    buildChatRequest({ prompt: "hi", model: "claude-opus-4-8", manualModel: true }),
    { query: "hi", forced_model_key: "claude-opus-4-8", agent_name: null, model_pick_source: "manual" },
  );
});

test("agent passes through; manual without a model stays auto", () => {
  assert.deepEqual(buildChatRequest({ prompt: "go", agent: "neo", manualModel: true }), {
    query: "go",
    forced_model_key: null,
    agent_name: "neo",
    model_pick_source: "auto",
  });
});

test("hosted request builders reject the Ollama namespace", () => {
  assert.throws(
    () => buildChatRequest({ prompt: "hi", model: "ollama:gemma3:4b", manualModel: true }),
    /local-only/,
  );
  assert.throws(
    () => buildDevSessionRequest({
      task: "fix it", model: "ollama:gemma3:4b", capabilities: [], protocolVersion: 1,
    }),
    /local-only/,
  );
});
