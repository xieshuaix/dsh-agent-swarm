import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coerceSwarm, createSwarmStore, emptySwarm } from "../lib/store.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "dsh-agent-swarm-"));
}

test("emptySwarm returns a valid empty projection", () => {
  const swarm = emptySwarm();
  assert.equal(swarm.version, 1);
  assert.equal(swarm.phase, "recruiting");
  assert.deepEqual(swarm.plan, []);
  assert.deepEqual(swarm.agents, []);
  assert.equal(swarm.summary, null);
  assert.equal(swarm.concurrencyLimit, 3);
});

test("store round-trips a swarm projection", () => {
  const dir = tempDir();
  try {
    const store = createSwarmStore(dir);
    const sessionId = "session-1";
    const swarm = {
      ...emptySwarm(),
      id: "swarm-1",
      phase: "executing",
      objective: "build a thing",
      plan: [{ id: "p1", title: "step one", status: "done", ownerId: "a1" }],
      agents: [{ id: "a1", name: "Aria", role: "builder", task: "build", status: "complete", progress: 100, childId: "c1" }],
      summary: null
    };
    store.save(sessionId, swarm);
    const loaded = store.load(sessionId);
    assert.deepEqual(loaded, swarm);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("coerceSwarm clamps and sanitizes hostile input", () => {
  const swarm = coerceSwarm({
    version: 1,
    phase: "not-a-phase",
    plan: [
      { id: 1, title: 42, status: "bogus" },
      "garbage",
      null
    ],
    agents: [
      { id: "a", name: 7, role: null, status: "weird", progress: 999, childId: 3 },
      null
    ],
    concurrencyLimit: 100000,
    recruitedCount: "9",
    completedCount: "3",
    updatedAt: "123",
    summary: 42
  });

  assert.equal(swarm.phase, "recruiting");
  assert.equal(swarm.plan.length, 1);
  assert.equal(swarm.plan[0].title, "");
  assert.equal(swarm.plan[0].status, "pending");
  assert.equal(swarm.agents.length, 1);
  assert.equal(swarm.agents[0].progress, 100); // clamped to 0..100
  assert.equal(swarm.agents[0].status, "recruiting");
  assert.equal(swarm.concurrencyLimit, 64); // clamped to 1..64
  assert.equal(swarm.recruitedCount, 9);
  assert.equal(swarm.completedCount, 3);
  assert.equal(swarm.updatedAt, 123);
  assert.equal(swarm.summary, ""); // non-string summary coerces to empty
});

test("coerceSwarm rejects a corrupt/non-v1 record to empty", () => {
  assert.deepEqual(coerceSwarm(null), emptySwarm());
  assert.deepEqual(coerceSwarm({ version: 2 }), emptySwarm());
  assert.deepEqual(coerceSwarm("nope"), emptySwarm());
});

// Regression: coerceSwarm used to force `avatarId: "orca"` and
// `progressMode: "continuous"` onto every agent, which suppressed state()'s
// per-index avatar/color and discrete-mode derivation (every agent showed the
// same avatar and never went discrete).
test("coerceSwarm does not force-default avatarId or progressMode", () => {
  const swarm = coerceSwarm({
    version: 1,
    agents: [{ id: "a1", name: "Aria", role: "b", task: "t", status: "complete", progress: 100 }]
  });
  const agent = swarm.agents[0];
  assert.equal("avatarId" in agent, false, "avatarId must be left unset so state() derives it");
  assert.equal("progressMode" in agent, false, "progressMode must be left unset so state() derives it");
});

test("coerceSwarm round-trips plan windows + per-agent evidence + topology", () => {
  const swarm = coerceSwarm({
    version: 1,
    plan: [{ id: "p1", title: "x", status: "done", ownerId: "a1", minProgress: 0, maxProgress: 50 }],
    agents: [{
      id: "a1", name: "Aria", role: "b", task: "t", status: "complete", progress: 100,
      childId: "c1", color: "#123456", avatarId: "orca", progressMode: "discrete",
      discreteTotal: 2, wave: 1, systemPrompt: "sp", agentsMd: "md",
      plan: [{ id: "ap1", title: "s", status: "done", ownerId: "a1", minProgress: 0, maxProgress: 100 }],
      todos: [{ id: "t1", text: "s", done: true }],
      logs: [{ id: "l1", type: "action", content: "write", tool: "write", minProgress: 0 }],
      artifacts: [{ id: "f1", name: "a.ts", path: "d/a.ts", size: "3", artifactType: "file", language: "ts", minProgress: 100 }]
    }],
    resources: [{ id: "r1", name: "a.ts", rtype: "file", ownerId: "a1", zone: "shared" }],
    lines: [{ from: "a1", to: "a2", type: "delegates" }],
    positions: { a1: { x: 1, y: 2 } },
    permissions: { "a1->a2": { read: true, write: false, execute: false } },
    messages: [{ id: "m1", role: "assistant", content: "hi", toolCalls: [{ type: "bash", label: "bash", detail: "{}" }] }]
  });

  assert.equal(swarm.plan[0].minProgress, 0);
  assert.equal(swarm.plan[0].maxProgress, 50);
  const a = swarm.agents[0];
  assert.equal(a.color, "#123456");
  assert.equal(a.avatarId, "orca");
  assert.equal(a.progressMode, "discrete");
  assert.equal(a.discreteTotal, 2);
  assert.equal(a.wave, 1);
  assert.equal(a.systemPrompt, "sp");
  assert.equal(a.agentsMd, "md");
  assert.equal(a.plan[0].minProgress, 0);
  assert.equal(a.plan[0].maxProgress, 100);
  assert.equal(a.todos[0].done, true);
  assert.equal(a.logs[0].tool, "write");
  assert.equal(a.logs[0].minProgress, 0);
  assert.equal(a.artifacts[0].artifactType, "file");
  assert.equal(a.artifacts[0].language, "ts");
  assert.equal(swarm.resources[0].rtype, "file");
  assert.equal(swarm.lines[0].type, "delegates");
  assert.deepEqual(swarm.positions, { a1: { x: 1, y: 2 } });
  assert.deepEqual(swarm.permissions, { "a1->a2": { read: true, write: false, execute: false } });
  assert.equal(swarm.messages[0].toolCalls[0].type, "bash");
});

test("store load of a missing file starts empty", () => {
  const dir = tempDir();
  try {
    const store = createSwarmStore(dir);
    assert.deepEqual(store.load("missing"), emptySwarm());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store drop removes a session file", () => {
  const dir = tempDir();
  try {
    const store = createSwarmStore(dir);
    store.save("s", { ...emptySwarm(), id: "swarm-s" });
    assert.ok(store.load("s").id === "swarm-s");
    store.drop("s");
    assert.deepEqual(store.load("s"), emptySwarm());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
