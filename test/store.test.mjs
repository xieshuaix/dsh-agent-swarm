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
