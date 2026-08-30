// dsh-agent-swarm — durable per-session swarm-orchestration state.
//
// The swarm lifecycle the main agent runs is: recruit subagents → plan the
// orchestration (or delegate planning to a subagent) → execute → summarize.
// That lifecycle is observable to the web UI and to the model, so its
// *presentation* state (the recruited roster, shared plan, and per-agent
// progress) must survive a host restart and follow a session by identity.
//
// The state is deliberately NOT appended as a custom session event: the
// harness's `KNOWN_SESSION_EVENT_TYPES` vocabulary is closed to in-repo
// packages, so a plugin-invented durable event type would make a session
// unloadable by any harness build that does not ship this plugin (see the
// session-channel comment in dsh-folder-permissions). A per-session JSON file
// under `$DSH_HOME/agent-swarm/` gives the same durability guarantee — across
// restart, isolated per session — with no core coupling.
//
// The durable store only records *presentation* projections. The authoritative
// subagent truth stays in `ctx.subagents` (child sessions, start/end lifecycle
// events) and the owning session log; the store is a cache the UI renders and
// the model reads for context, never the source of orchestration truth.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Every plan-item status this plugin understands. */
export const PLAN_STATUSES = ["pending", "in_progress", "done"];

/** Every agent status in the roster projection. */
export const AGENT_STATUSES = [
  "recruiting",
  "queued",
  "active",
  "complete",
  "error"
];

/** Every swarm phase in the orchestration lifecycle. */
export const SWARM_PHASES = [
  "recruiting",
  "planning",
  "awaiting_confirm",
  "executing",
  "complete"
];

/** The empty swarm record. */
export function emptySwarm() {
  return {
    version: 1,
    id: null,
    phase: "recruiting",
    objective: "",
    plan: [],
    agents: [],
    summary: null,
    concurrencyLimit: 3,
    recruitedCount: 0,
    completedCount: 0,
    // Current dispatch "batch" — the ideal UI shows only this batch's agents,
    // while the Swarm tab shows every batch (session-level). See row 17.
    batch: 0,
    // Orchestration topology + evidence the ideal UI renders (see
    // dsh-agent-swarm-ui/SWARM_DATA_GAP.md). Rows 10–12, 15.
    resources: [],
    lines: [],
    positions: {},
    permissions: {},
    messages: [],
    updatedAt: 0
  };
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceString(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

/** Sanitize one plan item, including its progress window (row 4). */
function coercePlanItem(item) {
  return {
    id: coerceString(item.id),
    title: coerceString(item.title),
    status: PLAN_STATUSES.includes(item.status) ? item.status : "pending",
    ownerId: typeof item.ownerId === "string" ? item.ownerId : null,
    minProgress: Number.isFinite(Number(item.minProgress)) ? Number(item.minProgress) : 0,
    maxProgress: Number.isFinite(Number(item.maxProgress)) ? Number(item.maxProgress) : 100
  };
}

/** Sanitize one per-agent todo item. */
function coerceTodoItem(item) {
  return {
    id: coerceString(item.id),
    text: coerceString(item.text),
    done: item.done === true
  };
}

/** Sanitize one per-agent artifact entry (row 2). */
function coerceArtifact(item) {
  return {
    id: coerceString(item.id),
    name: coerceString(item.name),
    path: coerceString(item.path),
    size: coerceString(item.size),
    artifactType: ["file", "schema", "test", "doc", "report", "plan"].includes(item.artifactType)
      ? item.artifactType
      : "file",
    ...(typeof item.language === "string" && item.language !== "" ? { language: item.language } : {}),
    ...(typeof item.content === "string" ? { content: item.content } : {}),
    minProgress: Number.isFinite(Number(item.minProgress)) ? Number(item.minProgress) : 0
  };
}

/** Sanitize one per-agent log entry (row 1). */
function coerceLog(item) {
  return {
    id: coerceString(item.id),
    type: ["thinking", "action", "result", "text"].includes(item.type) ? item.type : "text",
    content: coerceString(item.content),
    ...(typeof item.tool === "string" ? { tool: item.tool } : {}),
    minProgress: Number.isFinite(Number(item.minProgress)) ? Number(item.minProgress) : 0
  };
}

/** Sanitize one message + its tool-calls from the parent session (row 15). */
function coerceToolCall(item) {
  return {
    type: ["bash", "read", "context", "write", "agent"].includes(item.type) ? item.type : "agent",
    label: coerceString(item.label),
    detail: coerceString(item.detail)
  };
}

function coerceMessage(item) {
  return {
    id: coerceString(item.id),
    role: item.role === "user" ? "user" : "assistant",
    content: coerceString(item.content),
    ...(Array.isArray(item.toolCalls) ? { toolCalls: item.toolCalls.map(coerceToolCall) } : {})
  };
}

/** Sanitize one canvas resource (row 12). */
function coerceResource(item) {
  return {
    id: coerceString(item.id),
    name: coerceString(item.name),
    rtype: coerceString(item.rtype, "file"),
    ownerId: coerceString(item.ownerId),
    zone: coerceString(item.zone, "shared")
  };
}

/** Sanitize one canvas delegation edge (row 11). */
function coerceLine(item) {
  return {
    from: coerceString(item.from),
    to: coerceString(item.to),
    type: item.type === "delegates" ? "delegates" : "reports"
  };
}

/** Sanitize a persisted swarm record into a valid in-memory projection. */
export function coerceSwarm(raw) {
  const base = emptySwarm();
  if (!isRecord(raw) || raw.version !== 1) return base;
  const id = typeof raw.id === "string" ? raw.id : null;
  const phase = SWARM_PHASES.includes(raw.phase) ? raw.phase : "recruiting";
  const plan = Array.isArray(raw.plan)
    ? raw.plan
        .filter((item) => isRecord(item))
        .map(coercePlanItem)
    : [];
  const agents = Array.isArray(raw.agents)
    ? raw.agents
        .filter((agent) => isRecord(agent))
        .map((agent) => ({
          id: coerceString(agent.id),
          name: coerceString(agent.name),
          role: coerceString(agent.role),
          task: coerceString(agent.task),
          status: AGENT_STATUSES.includes(agent.status) ? agent.status : "recruiting",
          progress: Number.isFinite(Number(agent.progress))
            ? Math.max(0, Math.min(100, Number(agent.progress)))
            : 0,
          childId: typeof agent.childId === "string" ? agent.childId : null,
          // Per-agent presentation metadata (rows 7–9, 16).
          ...(typeof agent.color === "string" && agent.color !== "" ? { color: agent.color } : {}),
          ...(typeof agent.avatarId === "string" && agent.avatarId !== "" ? { avatarId: agent.avatarId } : {}),
          ...(agent.progressMode === "discrete" || agent.progressMode === "continuous"
            ? { progressMode: agent.progressMode }
            : {}),
          ...(Number.isFinite(Number(agent.discreteTotal))
            ? { discreteTotal: Number(agent.discreteTotal) }
            : {}),
          ...(Number.isFinite(Number(agent.wave)) ? { wave: Number(agent.wave) } : {}),
          ...(typeof agent.systemPrompt === "string" ? { systemPrompt: agent.systemPrompt } : {}),
          ...(typeof agent.agentsMd === "string" ? { agentsMd: agent.agentsMd } : {}),
          ...(typeof agent.rolePrompt === "string" ? { rolePrompt: agent.rolePrompt } : {}),
          ...(typeof agent.model === "string" ? { model: agent.model } : {}),
          ...(typeof agent.reasoningEffort === "string" ? { reasoningEffort: agent.reasoningEffort } : {}),
          ...(agent.outlinePlan === true ? { outlinePlan: true } : {}),
          ...(Number.isFinite(Number(agent.batch)) ? { batch: Number(agent.batch) } : {}),
          ...(Array.isArray(agent.plan) ? { plan: agent.plan.map(coercePlanItem) } : {}),
          ...(Array.isArray(agent.todos) ? { todos: agent.todos.map(coerceTodoItem) } : {}),
          ...(Array.isArray(agent.artifacts) ? { artifacts: agent.artifacts.map(coerceArtifact) } : {}),
          ...(Array.isArray(agent.logs) ? { logs: agent.logs.map(coerceLog) } : {})
        }))
    : [];
  const resources = Array.isArray(raw.resources)
    ? raw.resources.filter((item) => isRecord(item)).map(coerceResource)
    : [];
  const lines = Array.isArray(raw.lines)
    ? raw.lines.filter((item) => isRecord(item)).map(coerceLine)
    : [];
  const positions = isRecord(raw.positions) ? raw.positions : {};
  const permissions = isRecord(raw.permissions) ? raw.permissions : {};
  const messages = Array.isArray(raw.messages)
    ? raw.messages.filter((item) => isRecord(item)).map(coerceMessage)
    : [];
  const summary =
    raw.summary === null || raw.summary === undefined
      ? null
      : coerceString(raw.summary);
  return {
    version: 1,
    id,
    phase,
    objective: coerceString(raw.objective),
    plan,
    agents,
    summary,
    batch: Number.isFinite(Number(raw.batch)) ? Number(raw.batch) : 0,
    concurrencyLimit: Number.isFinite(Number(raw.concurrencyLimit))
      ? Math.max(1, Math.min(64, Number(raw.concurrencyLimit)))
      : 3,
    recruitedCount: Number.isFinite(Number(raw.recruitedCount))
      ? Number(raw.recruitedCount)
      : 0,
    completedCount: Number.isFinite(Number(raw.completedCount))
      ? Number(raw.completedCount)
      : 0,
    resources,
    lines,
    positions,
    permissions,
    messages,
    updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : 0
  };
}

/**
 * A durable, per-session swarm store under `rootDir`. Loads lazily (cached in
 * memory per session id) and writes atomically (temp + rename) so a crash
 * mid-save never corrupts an existing file.
 *
 * @param {string} rootDir - directory that holds one `<sessionId>.json` per session.
 */
export function createSwarmStore(rootDir) {
  const cache = new Map();

  function fileFor(sessionId) {
    return join(rootDir, `${sessionId}.json`);
  }

  function load(sessionId) {
    const key = String(sessionId);
    if (cache.has(key)) return cache.get(key);
    let swarm = emptySwarm();
    const file = fileFor(key);
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        swarm = coerceSwarm(parsed);
      } catch {
        // A corrupt/unreadable file starts empty — never guessed.
      }
    }
    cache.set(key, swarm);
    return swarm;
  }

  function save(sessionId, swarm) {
    const key = String(sessionId);
    mkdirSync(rootDir, { recursive: true });
    const file = fileFor(key);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(swarm, null, 2));
    renameSync(tmp, file);
    cache.set(key, swarm);
  }

  function drop(sessionId) {
    const key = String(sessionId);
    cache.delete(key);
    try {
      rmSync(fileFor(key), { force: true });
    } catch {
      // Best-effort cleanup; a lingering file is harmless (load() starts empty).
    }
  }

  return { fileFor, load, save, drop };
}

/** Resolve the harness home; mirrors dsh-home-paths without importing it. */
export function swarmStoreDir() {
  return join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "agent-swarm");
}
