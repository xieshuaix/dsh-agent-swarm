// dsh-agent-swarm — host half: a per-session multi-agent orchestration service.
//
// The main agent runs a swarm: recruit subagents → plan the orchestration (its
// own plan, or delegate planning to one subagent) → execute → summarize. This
// plugin provides that lifecycle as a first-class `ctx.swarm` service, drives
// the real subagent seam (`ctx.subagents`), and surfaces the projection to the
// model (slash command + system-prompt context) and to the web UI (a loopback
// HTTP data plane the client tab polls).
//
// Authority model: the *main agent* owns the lifecycle. This plugin never runs
// its own LLM loop — it supplies the recruitment/planning/confirmation
// scaffolding and records the projection. The main agent invokes it through
// the `/swarm` command; the web UI invokes it through the loopback route.
//
// Persistence: presentation projections live in a per-session JSON file under
// `$DSH_HOME/agent-swarm/` (see store.js). The authoritative subagent truth
// stays in `ctx.subagents` and the owning session log; the store is a durable
// cache the model and UI read, never the source of orchestration truth.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_STATUSES,
  SWARM_PHASES,
  coerceSwarm,
  createSwarmStore,
  emptySwarm,
  swarmStoreDir
} from "./store.js";

const name = "agent-swarm";

/** Services this plugin needs before it can mount. `sessions` is always host. */
const inject = ["sessions", "tools"];

/** Loopback-only addresses for the HTTP mutation surface (web-UI trust level). */
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** The plan JSON schema the delegated planner must satisfy (outputSchema). */
const PLAN_SCHEMA = {
  type: "object",
  properties: {
    plan: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          ownerId: { type: "string" },
          role: { type: "string" }
        },
        required: ["title"]
      }
    }
  },
  required: ["plan"]
};

function isLoopback(address) {
  return LOOPBACK.has(address ?? "");
}

/** Filename of the per-folder subagent provenance marker. */
const MARKER_FILENAME = ".dsh-subagent.json";

/** Built ideal-UI bundle this plugin serves into the native DSH web app. */
const UI_DIST_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "ui-dist");
const UI_ROUTE_PREFIX = "/dsh-agent-swarm/ui";

const UI_CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon"
};

/** Serve the ideal-UI bundle (SPA fallback to index.html). */
function serveUiStatic(res, pathname) {
  const rel = pathname === "" || pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  let file = join(UI_DIST_DIR, rel);
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(UI_DIST_DIR, "index.html");
  if (!existsSync(file)) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  res.writeHead(200, {
    "content-type": UI_CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
    "cache-control": "no-store"
  });
  res.end(readFileSync(file));
}

/** The parent chat turn active at a given instant (last `turn/start` event). */
function currentTurn(session) {
  let turn = 0;
  for (const event of session?.events ?? []) {
    if (event.type === "turn/start") turn = event.data?.turn ?? turn;
  }
  return turn;
}

/** Deterministic avatar id per roster index (row 7) — keys the UI's avatar set. */
const AVATAR_IDS = [
  "orca", "beluga", "dolphin-2", "humpback", "narwhal", "pilot",
  "whale-shark", "penguin-2", "seal", "gray-whale", "orca-4", "beluga-2"
];

/** Deterministic ring color per roster index (row 8). */
const AVATAR_COLORS = [
  "#5b8cff", "#ff7a59", "#34c759", "#af52de",
  "#ffcc00", "#ff2d55", "#64d2ff", "#30d158"
];

/** Map a file extension to the UI's artifact `rtype` (row 2/12). */
function artifactTypeFor(rel) {
  const ext = (rel ?? "").toLowerCase().split(".").pop();
  switch (ext) {
    case "json": return "schema";
    case "test": case "spec": return "test";
    case "md": case "mdx": return "doc";
    case "txt": case "log": return "report";
    case "plan": return "plan";
    default: return "file";
  }
}

/** Map a file extension to a language hint for syntax highlighting. */
function languageFor(rel) {
  const ext = (rel ?? "").toLowerCase().split(".").pop();
  return ({
    js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
    ts: "typescript", tsx: "typescript",
    py: "python", rb: "ruby", go: "go", rs: "rust",
    java: "java", c: "c", cpp: "cpp", h: "c",
    json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
    md: "markdown", html: "html", css: "css", sh: "shell", sql: "sql"
  })[ext];
}

/** The effective instruction text a child is spawned with (row 5). */
function composeSystemPrompt(rolePrompt, task, outlinePlan) {
  const parts = [];
  if (outlinePlan) parts.push("First outline a step-by-step plan, then execute it.");
  if (rolePrompt !== "") parts.push(`Role: ${rolePrompt}`);
  if (task !== "") parts.push(`Task: ${task}`);
  return parts.join("\n");
}

/** Read the workspace's AGENTS.md (or .dsh/AGENTS.md), best-effort (row 6). */
function readAgentsMd(root) {
  for (const candidate of [join(root, "AGENTS.md"), join(root, ".dsh", "AGENTS.md"), join(root, "CLAUDE.md")]) {
    try {
      if (existsSync(candidate)) return readFileSync(candidate, "utf8");
    } catch {
      // Best-effort; fall through to the next candidate.
    }
  }
  return "";
}

/** Derive a progress window for one plan item given its index and plan length. */
function planWindow(index, total) {
  if (total <= 0) return { minProgress: 0, maxProgress: 100 };
  return {
    minProgress: Math.round((index / total) * 100),
    maxProgress: Math.round(((index + 1) / total) * 100)
  };
}

/** The workspace root a subagent's writes land under (parent session cwd). */
function workspaceRoot(session) {
  return session?.header?.cwd ?? process.cwd();
}

/** Top-level directory names under a root, for best-effort folder attribution. */
function topLevelDirs(root) {
  try {
    return new Set(
      readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    );
  } catch {
    return new Set();
  }
}

/** Top-level file names (not dirs) under a root, for root-level artifact capture. */
function topLevelFiles(root) {
  try {
    return new Set(
      readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
    );
  } catch {
    return new Set();
  }
}

/** List files (relative paths + sizes) under a directory, depth-first, capped. */
function listFiles(dir, max = 200) {
  const out = [];
  const walk = (current, prefix) => {
    if (out.length >= max) return;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= max) return;
      if (entry.name.startsWith(".")) continue; // skip .git, .dsh-subagent.json, node_modules markers
      const full = join(current, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, rel);
      else {
        let size = "";
        try { size = String(statSync(full).size); } catch { /* keep empty */ }
        out.push({ rel, size });
      }
    }
  };
  walk(dir, "");
  return out;
}

/**
 * Write one provenance marker into a produced folder, so a later scan of
 * `.dsh-subagent.json` files reveals which subagent (id), parent session, chat
 * turn, and time produced the code. Best-effort: never fails a swarm over it.
 */
function writeSubagentMarker(dir, meta) {
  try {
    writeFileSync(
      join(dir, MARKER_FILENAME),
      JSON.stringify({
        kind: "dsh-subagent",
        version: 1,
        producer: "dsh-agent-swarm",
        subagent: {
          id: meta.childId,
          name: meta.name,
          role: meta.role,
          task: meta.task
        },
        parent: {
          sessionId: meta.parentSessionId,
          turn: meta.turn,
          objective: meta.objective
        },
        timestamps: {
          spawnedAtMs: meta.spawnedAt,
          spawnedAtIso: new Date(meta.spawnedAt).toISOString(),
          completedAtMs: meta.completedAt,
          completedAtIso: new Date(meta.completedAt).toISOString()
        },
        status: meta.completed ? "complete" : "error"
      }, null, 2)
    );
  } catch {
    // Provenance is best-effort; never let a marker write break the swarm.
  }
}

/** Read a folder's `.dsh-subagent.json` marker and return the producing subagent id. */
function readMarkerSubagent(dir) {
  try {
    const marker = JSON.parse(readFileSync(join(dir, MARKER_FILENAME), "utf8"));
    return typeof marker?.subagent?.id === "string" ? marker.subagent.id : "";
  } catch {
    return "";
  }
}

/** JSON-stringify for matching, never throwing on circular/odd input. */
function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? "");
  }
}

/**
 * Normalize a tool/call event's arguments across the two event shapes DSH
 * emits: the session log stores them as a JSON string under `data.arguments`,
 * while some runtime paths expose `data.input` / `data.args` as objects. Always
 * returns a string so it can be substring-matched for file paths.
 */
function toolCallInput(event) {
  const raw = event?.data?.arguments ?? event?.data?.input ?? event?.data?.args ?? "";
  return typeof raw === "string" ? raw : safeStringify(raw);
}

/**
 * Resolve a plan `ownerId` to a roster agent id. The main agent may write a
 * plan ownerId that does not EXACTLY match a recruited agent id (e.g. "html"
 * vs "html-builder", or a raw display name). Match by exact id, normalized id,
 * normalized name, then by prefix. Returns the canonical agent id on a match,
 * otherwise the original ownerId (so callers preserve it verbatim).
 */
function resolveAgentId(swarm, ownerId) {
  if (typeof ownerId !== "string" || ownerId === "") return null;
  const norm = (s) => String(s).toLowerCase().replace(/\W+/g, "-").replace(/^-+|-+$/g, "");
  const target = norm(ownerId);
  if (target === "") return null;
  for (const agent of swarm?.agents ?? []) {
    const aid = norm(agent.id);
    const aname = norm(agent.name);
    if (aid === target || aname === target) return agent.id;
    if (aid !== "" && (aid.startsWith(target) || target.startsWith(aid))) return agent.id;
    if (aname !== "" && (aname.startsWith(target) || target.startsWith(aname))) return agent.id;
  }
  return ownerId;
}

/** Prompt directive appended when a subagent is asked to outline a plan first. */
const PLAN_OUTLINE_DIRECTIVE = 'First outline your plan as a JSON object in a single fenced json code block, shaped exactly as: {"plan":[{"title":"step one"},{"title":"step two"}]}. Then execute the plan step by step.';

/**
 * Parse the plan a subagent outlined out of its final output: a fenced json
 * block carrying `{"plan":[{"title":"…"}]}` (or a bare JSON array). Returns
 * null when the output did not carry a parseable plan.
 */
function parsePlanFromOutput(output) {
  const text = (Array.isArray(output) ? output : [])
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join("\n");
  if (text.trim() === "") return null;
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = match ? match[1] : text;
  try {
    const parsed = JSON.parse(candidate);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.plan)) return parsed.plan;
  } catch {
    // not JSON — try the first {…} block
    const obj = text.match(/\{[\s\S]*\}/);
    if (obj) {
      try {
        const parsed2 = JSON.parse(obj[0]);
        if (parsed2 && Array.isArray(parsed2.plan)) return parsed2.plan;
      } catch {
        /* give up */
      }
    }
  }
  return null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function normalizeList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => typeof entry === "string" && entry.trim().length > 0);
}

/** Resolve the live Agent for a session id, or undefined when not registered. */
function agentForSession(ctx, sessionId) {
  const agents = ctx.get("agents");
  if (agents && typeof agents.get === "function") return agents.get(sessionId);
  if (agents && typeof agents.list === "function") {
    return agents.list().find((agent) => agent.session?.id === sessionId || agent.id === sessionId);
  }
  return undefined;
}

/** Pick the subagent provider to spawn through: prefer `spawn`, then `fork`, else first. */
function defaultProvider(subagents) {
  const listed = subagents.list();
  if (listed.includes("spawn")) return "spawn";
  if (listed.includes("fork")) return "fork";
  return listed[0];
}

function apply(ctx, config = {}) {
  const cfg = {
    concurrencyLimit: Number.isFinite(Number(config.concurrencyLimit))
      ? Math.max(1, Math.min(64, Number(config.concurrencyLimit)))
      : 3,
    providers: normalizeList(config.providers),
    // Default model / reasoning effort for spawned subagents (the main agent can
    // override per-spawn via the spec, deciding by task difficulty and nature).
    model: typeof config.model === "string" && config.model !== "" ? config.model : null,
    reasoningEffort: typeof config.reasoningEffort === "string" && config.reasoningEffort !== "" ? config.reasoningEffort : null
  };
  const store = createSwarmStore(swarmStoreDir());

  /** The live run handles this session is waiting on, keyed by child/session id. */
  const runs = new Map(); // sessionId -> Map(childId, SubagentRun)
  /** roster childId -> roster agent id, so lifecycle events can update the roster. */
  const childToRoster = new Map(); // childId -> { sessionId, agentId }
  /** spawn provenance per childId, for writing folder markers on completion. */
  const spawnMeta = new Map(); // childId -> { agentId, name, role, task, objective, parentSessionId, turn, spawnedAt, root, before }

  // ── Swarm visualization event channel ──────────────────────────────────────
  // Standard envelope `{ ts, sessionId, type, data }`, published on three
  // channels: the Cordis event bus (`swarm/event`), a non-intrusive JSONL log
  // under `$DSH_HOME/agent-swarm/events/<sessionId>.jsonl`, and every open SSE
  // client for the session.
  const sseClients = new Map(); // sessionId -> Set<ServerResponse>
  const eventsRoot = join(swarmStoreDir(), "events");

  function emitSwarmEvent(sessionId, type, data) {
    const event = { ts: Date.now(), sessionId, type, data: data ?? {} };
    try { ctx.emit("swarm/event", event); } catch { /* best-effort */ }
    try {
      mkdirSync(eventsRoot, { recursive: true });
      appendFileSync(join(eventsRoot, `${sessionId}.jsonl`), JSON.stringify(event) + "\n");
    } catch { /* best-effort logging */ }
    const clients = sseClients.get(sessionId);
    if (clients) {
      for (const res of clients) {
        try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* drop dead client */ }
      }
    }
  }

  const runsFor = (sessionId) => {
    let map = runs.get(sessionId);
    if (map === undefined) {
      map = new Map();
      runs.set(sessionId, map);
    }
    return map;
  };

  const load = (sessionId) => store.load(sessionId);
  const persist = (sessionId, swarm) => store.save(sessionId, { ...swarm, updatedAt: Date.now() });

  const touch = (sessionId) => {
    const swarm = load(sessionId);
    return { swarm, save: () => persist(sessionId, swarm) };
  };

  const resolveSession = (session) => session ?? undefined;

  /**
   * Opt-in completion resume: when a `resumeMainWhenDone`-flagged swarm reaches
   * `complete`, wake the main agent with an ordinary follow-up turn telling it
   * to review the subagents' work. Idempotent via the persisted `resumeSent` flag;
   * an agent that is still `running` when the swarm completes is resumed once it
   * settles (`whenIdle`) so the completion is never missed.
   */
  const maybeResumeMain = (session) => {
    if (session === undefined) return;
    const swarm = load(session.id);
    if (swarm.resumeMainWhenDone !== true) return;
    if (swarm.resumeSent === true) return;
    if (swarm.phase !== "complete") return;
    swarm.resumeSent = true;
    persist(session.id, swarm);
    const agent = agentForSession(ctx, session.id);
    if (agent === undefined) return;
    const sendResume = () => {
      try {
        agent.followup({
          id: randomUUID(),
          role: "user",
          content: [{
            type: "text",
            text: `The agent swarm has completed (${swarm.completedCount}/${swarm.recruitedCount} agents finished). Review the subagents' work and continue with any follow-up.`
          }],
          source: { kind: "user" }
        });
      } catch (error) {
        ctx.logger?.warn(`agent-swarm: failed to resume main agent: ${String(error)}`);
      }
    };
    if (agent.status === "idle") sendResume();
    else if (typeof agent.whenIdle === "function") agent.whenIdle().then(sendResume).catch(() => {});
  };

  /** Current projection, self-healing a stale `executing` state on read. */
  const state = (session, latest = false) => {
    if (session === undefined) return emptySwarm();
    const swarm = load(session.id);
    if (closeOut(swarm)) persist(session.id, swarm);
    const root = workspaceRoot(session);
    const agentsMd = readAgentsMd(root);
    // Fold live per-child evidence (todos/logs/artifacts) + presentation
    // metadata (color/avatar/progress-mode/wave/systemPrompt/agentsMd) into
    // each roster agent's projection.
    const allAgents = swarm.agents.map((agent, index) => {
      const todos = readChildTodos(agent.childId);
      const logs = readChildLogs(agent.childId);
      const artifacts = listArtifacts(agent.childId, root);
      let plan = Array.isArray(agent.plan) ? agent.plan : undefined;
      // Fold the outlined plan live too: after a restart (or a pre-fix run) the
      // store may not have persisted it, but the child's session events still
      // carry the parseable JSON plan.
      if ((plan === undefined || plan.length === 0) && agent.outlinePlan === true) {
        const outlined = readChildPlan(agent.childId);
        if (outlined !== undefined) {
          plan = outlined.map((item, i) => ({
            id: `${agent.id}-plan-${i}`,
            title: typeof item?.title === "string" ? item.title : String(item?.title ?? ""),
            status: "done",
            ownerId: agent.id,
            ...planWindow(i, outlined.length)
          }));
        }
      }
      const ownedPlanCount = swarm.plan.filter((p) => resolveAgentId(swarm, p.ownerId) === agent.id).length;
      const discreteTotal = (plan?.length ?? 0) || ownedPlanCount || (todos?.length ?? 0);
      const out = { ...agent };
      out.color = agent.color ?? AVATAR_COLORS[index % AVATAR_COLORS.length];
      out.avatarId = agent.avatarId ?? AVATAR_IDS[index % AVATAR_IDS.length];
      out.progressMode = agent.progressMode ?? (discreteTotal > 0 ? "discrete" : "continuous");
      if (out.progressMode === "discrete" && out.discreteTotal === undefined && discreteTotal > 0) {
        out.discreteTotal = discreteTotal;
      }
      out.wave = agent.wave ?? Math.floor(index / (swarm.concurrencyLimit || 1)) + 1;
      out.systemPrompt =
        agent.systemPrompt ?? composeSystemPrompt(agent.rolePrompt ?? "", agent.task ?? "", agent.outlinePlan === true);
      if (agentsMd !== "") out.agentsMd = agentsMd;
      if (plan !== undefined) out.plan = plan;
      if (todos !== undefined) out.todos = todos;
      if (logs !== undefined) out.logs = logs;
      if (artifacts !== undefined) out.artifacts = artifacts;
      return out;
    });
    // The ideal UI is tied to the latest swarm call (batch); the Swarm tab is
    // session-level and sees every batch. Filter to the current batch only when
    // the "latest" view is requested.
    const currentBatch = swarm.batch ?? 0;
    const agents = latest && allAgents.length > 0
      ? allAgents.filter((a) => (a.batch ?? 0) === currentBatch)
      : allAgents;
    const resources = deriveResources(agents);
    const lines = deriveLines(swarm, agents);
    const positions = derivePositions(swarm, agents);
    const messages = readParentMessages(session);
    return {
      ...swarm,
      agents,
      ...(latest ? {
        recruitedCount: agents.length,
        completedCount: agents.filter((a) => a.status === "complete").length
      } : {}),
      resources,
      lines,
      positions,
      ...(messages !== undefined ? { messages } : {}),
      id: swarm.id ?? `swarm-${session.id}`,
      // The session's workspace root, so the UI can resolve each artifact's
      // workspace-relative path into an absolute path to open/copy.
      workspaceRoot: root
    };
  };

  // ---------------------------------------------------------------------------
  // Roster helpers
  // ---------------------------------------------------------------------------

  function upsertAgent(swarm, agent) {
    const index = swarm.agents.findIndex((entry) => entry.id === agent.id);
    if (index === -1) swarm.agents.push(agent);
    else swarm.agents[index] = { ...swarm.agents[index], ...agent };
  }

  function agentById(swarm, agentId) {
    return swarm.agents.find((entry) => entry.id === agentId);
  }

  function recount(swarm) {
    swarm.recruitedCount = swarm.agents.length;
    swarm.completedCount = swarm.agents.filter((entry) => entry.status === "complete").length;
  }

  /**
   * Close out a swarm that is `executing` but has no live agents left: mark plan
   * items owned by completed agents as done and flip the phase to `complete`.
   * Idempotent. Used both on agent settlement and as a read-time self-heal so a
   * projection written by older code (or a missed completion event) can never
   * linger in a stale `executing` state.
   */
  function closeOut(swarm) {
    for (const agent of swarm.agents) {
      if (agent.status !== "complete") continue;
      for (const item of swarm.plan) {
        if (item.ownerId === agent.id && item.status !== "done") item.status = "done";
      }
    }
    recount(swarm);
    if (
      swarm.phase === "executing" &&
      swarm.agents.length > 0 &&
      swarm.agents.every((entry) => entry.status === "complete" || entry.status === "error")
    ) {
      swarm.phase = "complete";
      return true;
    }
    return false;
  }

  /**
   * Settle one agent's terminal state in the projection: mark complete/error,
   * then close out the swarm. Shared by the run-result callback and the
   * subagent/end event handler so completion is robust regardless of which
   * path fires.
   */
  function settleAgent(swarm, agentId, completed) {
    const agent = agentById(swarm, agentId);
    if (agent) {
      agent.status = completed ? "complete" : "error";
      agent.progress = completed ? 100 : agent.progress;
    }
    closeOut(swarm);
    return agent;
  }

  /** Write provenance markers into every top-level dir created during a child run. */
  function writeMarkersForChild(childId, completed) {
    const meta = spawnMeta.get(childId);
    if (meta === undefined) return;
    const after = topLevelDirs(meta.root);
    for (const dirName of after) {
      if (meta.before.has(dirName)) continue;
      if (!childOwnsDir(childId, dirName, meta.root)) continue;
      writeSubagentMarker(join(meta.root, dirName), {
        childId,
        name: meta.name,
        role: meta.role,
        task: meta.task,
        objective: meta.objective,
        parentSessionId: meta.parentSessionId,
        turn: meta.turn,
        spawnedAt: meta.spawnedAt,
        completedAt: Date.now(),
        completed
      });
    }
  }

  /**
   * Read a child's live todo list from its latest `todo/write` event, mapping
   * DSH todo status (`completed`/`in_progress`/`pending`) to the tab's
   * `done` boolean. Returns undefined when the child session isn't readable.
   */
  function readChildTodos(childId) {
    if (typeof childId !== "string" || childId === "") return undefined;
    const session = ctx.sessions?.get?.(childId);
    if (session === undefined || !Array.isArray(session.events)) return undefined;
    let todos;
    for (const event of session.events) {
      if (event.type === "todo/write") todos = event.data?.todos;
    }
    if (!Array.isArray(todos)) return undefined;
    return todos.map((item, index) => ({
      id: `${childId}-todo-${index}`,
      text: typeof item?.content === "string" ? item.content : String(item?.content ?? ""),
      done: item?.status === "completed"
    }));
  }

  /**
   * Read the child's outlined plan from its session events. The plan JSON is
   * emitted in an *early* assistant message (before the tool-use loop), so the
   * subagent run's final `result.output` may no longer carry it. Scan every
   * `assistant/message` for the first parseable plan and return it (raw titles).
   */
  function readChildPlan(childId) {
    if (typeof childId !== "string" || childId === "") return undefined;
    const session = ctx.sessions?.get?.(childId);
    if (session === undefined || !Array.isArray(session.events)) return undefined;
    for (const event of session.events) {
      if (event.type !== "assistant/message") continue;
      const text = (event.data?.message?.content ?? [])
        .filter((block) => block?.type === "text")
        .map((block) => block.text ?? "")
        .join("\n");
      const parsed = parsePlanFromOutput([{ type: "text", text }]);
      if (parsed) return parsed;
    }
    return undefined;
  }

  /**
   * Whether a child's session events reference a produced top-level dir name —
   * the best-effort ownership signal for artifact attribution when several
   * children spawn concurrently (so a naive `before`-snapshot diff is racy).
   */
  function childReferencedDir(childId, dirName) {
    if (typeof childId !== "string" || childId === "" || dirName === "") return false;
    const session = ctx.sessions?.get?.(childId);
    if (session === undefined || !Array.isArray(session.events)) return false;
    for (const event of session.events) {
      let haystack = "";
      if (event.type === "tool/call") {
        haystack = `${event.data?.name ?? ""} ${toolCallInput(event)}`;
      } else if (event.type === "assistant/message" || event.type === "assistant/chunk") {
        haystack = (event.data?.message?.content ?? [])
          .map((block) => (block?.type === "text" ? block.text ?? "" : ""))
          .join(" ");
      }
      if (haystack.includes(dirName)) return true;
    }
    return false;
  }

  /**
   * Whether a child's session events include a write-like tool call that names
   * a file — the signal for capturing root-level files the child produced, even
   * when the file already existed before the run (so a `before` diff would miss
   * it). Write-like tools: write/edit/bash/create/save (reads never count).
   */
  function childWroteFile(childId, fileName) {
    if (typeof childId !== "string" || childId === "" || fileName === "") return false;
    const session = ctx.sessions?.get?.(childId);
    if (session === undefined || !Array.isArray(session.events)) return false;
    for (const event of session.events) {
      if (event.type !== "tool/call") continue;
      const name = String(event.data?.name ?? "");
      if (!/write|edit|bash|create|save/i.test(name)) continue;
      // Prefer the target path (file_path/path/filePath) parsed from the
      // JSON-string `arguments`: a write's *content* often names sibling files,
      // so matching the path precisely avoids mis-attributing those siblings.
      const raw = event.data?.arguments ?? event.data?.input ?? event.data?.args;
      let parsed = raw;
      if (typeof raw === "string") {
        try { parsed = JSON.parse(raw); } catch { /* keep the raw string */ }
      }
      if (parsed !== null && typeof parsed === "object") {
        const target =
          typeof parsed.file_path === "string" ? parsed.file_path :
          typeof parsed.path === "string" ? parsed.path :
          typeof parsed.filePath === "string" ? parsed.filePath : "";
        if (target !== "") {
          if (target === fileName || target.endsWith(`/${fileName}`)) return true;
          continue; // a path tool aimed elsewhere — not this file
        }
      }
      // No parseable path (e.g. a bash `command`): substring-match the raw args.
      const haystack = `${name} ${toolCallInput(event)}`;
      if (haystack.includes(fileName)) return true;
    }
    return false;
  }

  /** Combined dir ownership: marker wins, then event-reference heuristic. */
  function childOwnsDir(childId, dirName, root) {
    const markerOwner = readMarkerSubagent(join(root, dirName));
    if (markerOwner === childId) return true;
    if (markerOwner !== "") return false; // stamped by a different child
    return childReferencedDir(childId, dirName);
  }

  /**
   * Read a child's activity log from its session events (tool calls, tool
   * results, assistant text). Returns undefined when the child session isn't
   * readable or produced no activity.
   */
  function readChildLogs(childId) {
    if (typeof childId !== "string" || childId === "") return undefined;
    const session = ctx.sessions?.get?.(childId);
    if (session === undefined || !Array.isArray(session.events)) return undefined;
    const logs = [];
    for (const event of session.events) {
      if (event.type === "tool/call") {
        const name = event.data?.name;
        logs.push({
          id: `${childId}-log-${logs.length}`,
          type: "action",
          content: typeof name === "string" ? name : "",
          ...(typeof name === "string" ? { tool: name } : {})
        });
      } else if (event.type === "tool/result") {
        const text = (event.data?.message?.content ?? [])
          .filter((block) => block?.type === "text")
          .map((block) => block.text ?? "")
          .join("");
        logs.push({ id: `${childId}-log-${logs.length}`, type: "result", content: text });
      } else if (event.type === "assistant/message") {
        const text = (event.data?.message?.content ?? [])
          .filter((block) => block?.type === "text")
          .map((block) => block.text ?? "")
          .join("");
        if (text !== "") logs.push({ id: `${childId}-log-${logs.length}`, type: "text", content: text });
      }
    }
    if (logs.length === 0) return undefined;
    // Monotonic scrub position so the UI can scrub the activity timeline.
    return logs.map((log, index) => ({
      ...log,
      minProgress: logs.length === 1 ? 0 : Math.round((index / (logs.length - 1)) * 100)
    }));
  }

  /**
   * List the files a child produced — both inside top-level directories it
   * created and root-level files it wrote directly (the toy app's subagents
   * write index.html/style.css/app.js straight into the workspace root, not a
   * folder). Returns undefined when the child produced no new files.
   *
   * Attribution is two-tier: while the spawn is in memory we diff the spawn-time
   * snapshot; after a host restart (spawnMeta lost) we fall back to the persisted
   * `.dsh-subagent.json` markers under `root`.
   */
  function listArtifacts(childId, root) {
    const meta = spawnMeta.get(childId);
    let base;
    let dirCandidates;
    let fileCandidates;
    if (meta !== undefined) {
      base = meta.root;
      dirCandidates = [...topLevelDirs(meta.root)].filter((dirName) => !meta.before.has(dirName));
      // Include ALL root files (not just the `before` diff) so a file the child
      // wrote over a pre-existing one is still attributed via childWroteFile.
      fileCandidates = [...topLevelFiles(meta.root)];
    } else if (typeof root === "string" && root !== "") {
      base = root;
      dirCandidates = [...topLevelDirs(root)];
      fileCandidates = [...topLevelFiles(root)];
    } else {
      return undefined;
    }

    const artifacts = [];
    const pushFile = (fullPath, rel, size) => {
      let content;
      try {
        content = readFileSync(fullPath, "utf8");
        if (content.length > 32 * 1024) content = content.slice(0, 32 * 1024) + "\n…";
      } catch {
        content = undefined;
      }
      artifacts.push({
        id: `${childId}-${rel}`,
        name: rel.split("/").pop(),
        path: rel,
        size,
        artifactType: artifactTypeFor(rel),
        ...(languageFor(rel) ? { language: languageFor(rel) } : {}),
        ...(content !== undefined ? { content } : {}),
        minProgress: 100
      });
    };

    // Top-level directories. When the child session is still loaded, attribute
    // each file to the child that actually wrote it (via write events) — so
    // several children sharing one directory each get only their own files.
    // When the session is unloaded (post-restart), fall back to marker-based
    // whole-directory ownership, since the write events are gone.
    const childEvents = ctx.sessions?.get?.(childId)?.events;
    const loaded = Array.isArray(childEvents);
    for (const dirName of dirCandidates) {
      const markerOwned = readMarkerSubagent(join(base, dirName)) === childId;
      if (!loaded && !markerOwned) continue;
      for (const file of listFiles(join(base, dirName))) {
        const rel = `${dirName}/${file.rel}`;
        if (loaded && !childWroteFile(childId, rel)) continue;
        pushFile(join(base, dirName, file.rel), rel, file.size);
      }
    }

    // Root-level files the child wrote directly (no folder). Attribute via the
    // child's write-like tool calls naming the file (reads never count).
    for (const fileName of fileCandidates) {
      if (fileName.startsWith(".")) continue;
      if (!childWroteFile(childId, fileName)) continue;
      let size = "";
      try { size = String(statSync(join(base, fileName)).size); } catch { /* keep empty */ }
      pushFile(join(base, fileName), fileName, size);
    }

    return artifacts.length > 0 ? artifacts : undefined;
  }

  /** Map a DSH tool name to the UI's `ToolCall.type` vocabulary (row 15). */
  function toolCallType(name) {
    const n = (name ?? "").toLowerCase();
    if (n.includes("bash") || n.includes("exec") || n.includes("shell")) return "bash";
    if (n.includes("read") || n.includes("grep") || n.includes("glob")) return "read";
    if (n.includes("write") || n.includes("edit") || n.includes("patch") || n.includes("mkdir")) return "write";
    if (n.includes("context")) return "context";
    return "agent";
  }

  /** Aggregate the parent session's assistant messages + tool calls (row 15). */
  function readParentMessages(session) {
    const events = session?.events ?? [];
    if (!Array.isArray(events) || events.length === 0) return undefined;
    const messages = [];
    let current = null;
    for (const event of events) {
      if (event.type === "assistant/message") {
        const text = (event.data?.message?.content ?? [])
          .filter((block) => block?.type === "text")
          .map((block) => block.text ?? "")
          .join("");
        current = {
          id: event.data?.message?.id ?? `msg-${messages.length}`,
          role: "assistant",
          content: text,
          toolCalls: []
        };
        messages.push(current);
      } else if (event.type === "tool/call") {
        const name = typeof event.data?.name === "string" ? event.data.name : "";
        const input = event.data?.arguments ?? event.data?.input ?? event.data?.args ?? {};
        let detail = "";
        try {
          detail = typeof input === "string" ? input : JSON.stringify(input);
          if (detail.length > 200) detail = `${detail.slice(0, 200)}…`;
        } catch {
          detail = "";
        }
        const call = { type: toolCallType(name), label: name, detail };
        if (current) current.toolCalls.push(call);
        else {
          current = { id: `msg-${messages.length}`, role: "assistant", content: "", toolCalls: [call] };
          messages.push(current);
        }
      }
    }
    return messages.length > 0 ? messages : undefined;
  }

  /** Derive canvas resources from each agent's produced artifacts (row 12). */
  function deriveResources(agents) {
    const resources = [];
    const seen = new Set();
    for (const agent of agents) {
      for (const artifact of agent.artifacts ?? []) {
        if (seen.has(artifact.id)) continue;
        seen.add(artifact.id);
        resources.push({
          id: artifact.id,
          name: artifact.name,
          rtype: artifact.artifactType ?? "file",
          ownerId: agent.id,
          // Each artifact lives in its OWNING agent's exclusive pool by default
          // (the canvas lets the user move it to the shared pool explicitly).
          zone: agent.id
        });
      }
    }
    return resources;
  }

  /** Derive delegation/report edges from the plan's owner assignments (row 11). */
  function deriveLines(swarm, agents) {
    const agentIds = new Set(agents.map((a) => a.id));
    const owners = new Set(
      swarm.plan
        .map((p) => resolveAgentId(swarm, p.ownerId))
        .filter((id) => id !== null)
    );
    // Orchestrator = the roster agent that nothing is delegated to (matches the
    // UI's root-of-delegation heuristic); fall back to the first agent.
    const orchestrator =
      agents.find((a) => !owners.has(a.id))?.id ?? agents[0]?.id ?? "";
    const lines = [];
    const seen = new Set();
    const push = (from, to, type) => {
      if (!agentIds.has(from) || !agentIds.has(to) || from === to) return;
      const key = `${from}->${to}:${type}`;
      if (seen.has(key)) return;
      seen.add(key);
      lines.push({ from, to, type });
    };
    for (const ownerId of owners) push(orchestrator, ownerId, "delegates");
    for (const ownerId of owners) push(ownerId, orchestrator, "reports");
    return lines;
  }

  /** Resolve canvas positions: persisted topology merged over a default layout (row 10). */
  function derivePositions(swarm, agents) {
    const positions = { ...(swarm.positions ?? {}) };
    agents.forEach((agent, index) => {
      if (positions[agent.id] === undefined) {
        positions[agent.id] = { x: 60 + index * 212, y: 80 };
      }
    });
    return positions;
  }

  /** Recruit a roster of agents (records only; spawning is separate via `spawn`). */
  const recruit = (session, agents, concurrency) => {
    if (session === undefined) return { ok: false, error: "no_active_session" };
    const { swarm, save } = touch(session.id);
    const list = Array.isArray(agents) ? agents : [];
    // Optional per-swarm concurrency override (clamped 1..64).
    if (Number.isFinite(Number(concurrency))) {
      swarm.concurrencyLimit = Math.max(1, Math.min(64, Number(concurrency)));
    }
    // A new swarm call starts after the previous one completed (or on a fresh
    // session): bump the batch so the ideal UI can show only THIS call's
    // agents, while the Swarm tab keeps every batch (session-level).
    if (list.length > 0 && (swarm.phase === "complete" || swarm.agents.length === 0)) {
      swarm.batch = (swarm.batch ?? 0) + 1;
    }
    const currentBatch = swarm.batch ?? 0;
    const recruitedIds = [];
    for (const raw of list) {
      if (raw === null || typeof raw !== "object") continue;
      const agentId = typeof raw.id === "string" && raw.id !== "" ? raw.id : randomUUID();
      recruitedIds.push(agentId);
      upsertAgent(swarm, {
        id: agentId,
        name: typeof raw.name === "string" ? raw.name : agentId,
        role: typeof raw.role === "string" ? raw.role : "worker",
        task: typeof raw.task === "string" ? raw.task : "",
        status: AGENT_STATUSES.includes(raw.status) ? raw.status : "queued",
        progress: Number.isFinite(Number(raw.progress)) ? Number(raw.progress) : 0,
        childId: typeof raw.childId === "string" ? raw.childId : null,
        batch: currentBatch,
        ...(typeof raw.rolePrompt === "string" && raw.rolePrompt !== "" ? { rolePrompt: raw.rolePrompt } : {}),
        ...(typeof raw.model === "string" && raw.model !== "" ? { model: raw.model } : {}),
        ...(typeof raw.reasoningEffort === "string" && raw.reasoningEffort !== "" ? { reasoningEffort: raw.reasoningEffort } : {}),
        ...(raw.outlinePlan === true ? { outlinePlan: true } : {})
      });
    }
    if (list.length > 0) swarm.phase = swarm.phase === "recruiting" ? "planning" : swarm.phase;
    swarm.id = swarm.id ?? randomUUID();
    recount(swarm);
    save();
    emitSwarmEvent(session.id, "swarm/phase", { phase: swarm.phase });
    for (const agentId of recruitedIds) {
      const entry = agentById(swarm, agentId);
      if (entry) emitSwarmEvent(session.id, "swarm/recruited", { agent: entry });
    }
    return { ok: true, swarm: { ...swarm } };
  };

  /** Record the orchestration plan (the main agent's own, or a delegated one). */
  const setPlan = (session, plan, meta = {}) => {
    if (session === undefined) return { ok: false, error: "no_active_session" };
    const { swarm, save } = touch(session.id);
    const list = Array.isArray(plan) ? plan : [];
    swarm.plan = list
      .filter((item) => item !== null && typeof item === "object")
      .map((item, index) => ({
        id: typeof item.id === "string" && item.id !== "" ? item.id : randomUUID(),
        title: typeof item.title === "string" ? item.title : "",
        status: ["pending", "in_progress", "done"].includes(item.status) ? item.status : "pending",
        ownerId: resolveAgentId(swarm, item.ownerId),
        // Progress windows (row 4): spread evenly over the plan; persisted so the
        // UI can scrub the plan without recomputing on the client.
        ...planWindow(index, list.length)
      }));
    swarm.phase = "awaiting_confirm";
    if (typeof meta.objective === "string" && meta.objective !== "") swarm.objective = meta.objective;
    save();
    emitSwarmEvent(session.id, "swarm/plan", { plan: swarm.plan });
    emitSwarmEvent(session.id, "swarm/phase", { phase: swarm.phase });
    return { ok: true, swarm: { ...swarm } };
  };

  /** Confirm the plan and begin execution: launch every queued agent as a subagent. */
  const confirm = async (session, opts = {}) => {
    if (session === undefined) return { ok: false, error: "no_active_session" };
    const { swarm, save } = touch(session.id);
    if (swarm.phase !== "awaiting_confirm" && swarm.phase !== "planning") {
      return { ok: false, error: `cannot confirm from phase "${swarm.phase}"` };
    }
    swarm.phase = "executing";
    if (opts.resumeMainWhenDone === true) swarm.resumeMainWhenDone = true;
    save();
    emitSwarmEvent(session.id, "swarm/phase", { phase: swarm.phase });

    // "Confirm & run": spawn each queued/recruiting roster entry as a one-shot
    // subagent. Spawning is best-effort per agent — one failure never blocks the
    // rest, and the roster reflects each child's real settlement.
    const objective = swarm.objective;
    const pending = swarm.agents.filter((agent) => agent.status === "queued" || agent.status === "recruiting");
    const limit = Math.max(1, Number(swarm.concurrencyLimit) || cfg.concurrencyLimit || 3);

    const spawnOne = (agent) => spawn(session, {
      id: agent.id,
      name: agent.name,
      role: agent.role,
      task: agent.task,
      ...(agent.rolePrompt ? { rolePrompt: agent.rolePrompt } : {}),
      ...(agent.model ? { model: agent.model } : {}),
      ...(agent.reasoningEffort ? { reasoningEffort: agent.reasoningEffort } : {}),
      ...(agent.outlinePlan ? { outlinePlan: true } : {}),
      label: `${agent.role || "worker"}-${agent.name}`.toLowerCase().replace(/\s+/g, "-"),
      ...(objective ? { objective } : {})
    }).catch((error) => {
      ctx.logger?.warn(`agent-swarm: confirm failed to spawn "${agent.id}": ${String(error)}`);
      return { ok: false, error: String(error) };
    });

    // Drain in waves of `limit` WITHOUT blocking confirm: spawn a batch, and only
    // when every run in it has settled, spawn the next batch — so at most `limit`
    // subagents run concurrently while confirm still returns immediately.
    let index = 0;
    const spawnNextWave = async () => {
      if (index >= pending.length) return;
      const batch = pending.slice(index, index + limit);
      index += limit;
      const spawned = await Promise.all(batch.map(spawnOne));
      await Promise.all(spawned.map((r) => r?.done ?? Promise.resolve()));
      void spawnNextWave();
    };
    void spawnNextWave();
    return { ok: true, swarm: state(session) };
  };

  /** Cancel a swarm: dispose tracked runs and rewind to recruiting. */
  const cancel = async (session) => {
    if (session === undefined) return { ok: false, error: "no_active_session" };
    const map = runsFor(session.id);
    const pending = [...map.values()];
    map.clear();
    await Promise.all(pending.map((run) => run.dispose().catch(() => {})));
    const { swarm, save } = touch(session.id);
    swarm.phase = "recruiting";
    for (const agent of swarm.agents) {
      if (agent.status === "active" || agent.status === "queued") agent.status = "recruiting";
    }
    save();
    emitSwarmEvent(session.id, "swarm/phase", { phase: swarm.phase });
    return { ok: true, swarm: { ...swarm } };
  };

  /** Record the end-of-swarm summary. */
  const summarize = (session, summary) => {
    if (session === undefined) return { ok: false, error: "no_active_session" };
    const { swarm, save } = touch(session.id);
    swarm.summary = typeof summary === "string" ? summary : "";
    swarm.phase = "complete";
    save();
    emitSwarmEvent(session.id, "swarm/summary", { summary: swarm.summary });
    emitSwarmEvent(session.id, "swarm/phase", { phase: swarm.phase });
    return { ok: true, swarm: { ...swarm } };
  };

  // ---------------------------------------------------------------------------
  // Real subagent spawning over ctx.subagents
  // ---------------------------------------------------------------------------

  /** Spawn one subagent (one-shot) and track it in the roster. */
  const spawn = async (session, spec) => {
    if (session === undefined) return { ok: false, error: "no_active_session" };
    const subagents = ctx.get("subagents");
    if (subagents === undefined || typeof subagents.start !== "function") {
      return { ok: false, error: "subagent service unavailable" };
    }
    const parent = agentForSession(ctx, session.id);
    if (parent === undefined) return { ok: false, error: "no live agent for session" };

    const provider = cfg.providers.length > 0 ? cfg.providers[0] : defaultProvider(subagents);
    if (subagents.getProvider(provider) === undefined) {
      return { ok: false, error: `no subagent provider "${provider}"` };
    }

    const label = typeof spec.label === "string" ? spec.label : "swarm-worker";
    const role = typeof spec.role === "string" ? spec.role : "worker";
    const task = typeof spec.task === "string" ? spec.task : "";
    const rolePrompt = typeof spec.rolePrompt === "string" && spec.rolePrompt.trim() !== "" ? spec.rolePrompt.trim() : "";
    const objective = typeof spec.objective === "string" && spec.objective.trim() !== "" ? spec.objective.trim() : "";
    const outlinePlan = spec.outlinePlan === true;

    // Model routing: the main agent picks per-spawn (falling back to the plugin
    // config), deciding by task difficulty and nature. e.g. `model:
    // "deepseek-v4-flash"` for cheap, no-thinking work.
    const model = typeof spec.model === "string" && spec.model !== "" ? spec.model : cfg.model;
    const reasoningEffort =
      typeof spec.reasoningEffort === "string" && spec.reasoningEffort !== ""
        ? spec.reasoningEffort
        : cfg.reasoningEffort;
    const maxTokens = Number.isFinite(Number(spec.maxTokens)) ? Number(spec.maxTokens) : undefined;
    const agentOptions = {
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {})
    };

    // Flexible, prompt-driven prompt assembly: an explicit `prompt` wins; else
    // compose role (persona) + task, plus an outline directive only when asked.
    // With neither role nor outline, the prompt is just the task (single prompt).
    // The role prompt is always labeled "Role:" so the persisted systemPrompt
    // reflects the persona the subagent actually ran with.
    let promptText;
    if (typeof spec.prompt === "string" && spec.prompt.trim() !== "") {
      // An explicit prompt wins, but the outline directive still applies when asked.
      const parts = [];
      if (outlinePlan) parts.push(PLAN_OUTLINE_DIRECTIVE);
      if (rolePrompt !== "") parts.push(`Role: ${rolePrompt}`);
      if (objective !== "") parts.push(`Objective: ${objective}`);
      parts.push(rolePrompt !== "" ? `Task: ${spec.prompt}` : spec.prompt);
      promptText = parts.join("\n\n");
    } else {
      const parts = [];
      const labeled = outlinePlan || rolePrompt !== "";
      if (outlinePlan) parts.push(PLAN_OUTLINE_DIRECTIVE);
      if (rolePrompt !== "") parts.push(`Role: ${rolePrompt}`);
      if (objective !== "") parts.push(`Objective: ${objective}`);
      parts.push(labeled ? `Task: ${task}` : task);
      promptText = parts.join("\n\n");
    }

    const agentId = typeof spec.id === "string" && spec.id !== "" ? spec.id : randomUUID();
    const { swarm, save } = touch(session.id);
    upsertAgent(swarm, {
      id: agentId,
      name: typeof spec.name === "string" ? spec.name : label,
      role,
      task,
      ...(rolePrompt !== "" ? { rolePrompt } : {}),
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(outlinePlan ? { outlinePlan: true } : {}),
      systemPrompt: promptText,
      status: "active",
      progress: 0,
      childId: null
    });
    swarm.phase = swarm.phase === "awaiting_confirm" ? "executing" : swarm.phase;
    recount(swarm);
    save();

    // Provenance snapshot: capture the spawn context before the child runs so
    // we can write a folder marker on completion and attribute new top-level
    // directories to this subagent.
    const spawnedAt = Date.now();
    const root = workspaceRoot(parent.session);
    const before = topLevelDirs(root);
    const beforeFiles = topLevelFiles(root);

    let run;
    try {
      run = await subagents.start(provider, {
        label,
        prompt: [{ type: "text", text: promptText }],
        parent,
        signal: AbortSignal.timeout(30 * 60 * 1000),
        ...(rolePrompt !== "" ? { persona: rolePrompt } : {}),
        ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {})
      });
    } catch (error) {
      settleAgent(swarm, agentId, false);
      save();
      return { ok: false, error: `spawn failed: ${String(error)}`, agentId };
    }

    runsFor(session.id).set(run.id, run);
    childToRoster.set(run.id, { sessionId: session.id, agentId });
    spawnMeta.set(run.id, {
      agentId,
      name: typeof spec.name === "string" ? spec.name : label,
      role,
      task,
      objective: swarm.objective,
      parentSessionId: session.id,
      turn: currentTurn(parent.session),
      spawnedAt,
      root,
      before,
      beforeFiles
    });
    const entry = agentById(swarm, agentId);
    if (entry) entry.childId = run.id;
    save();
    emitSwarmEvent(session.id, "swarm/agent/child", { agentId, childId: run.id });
    emitSwarmEvent(session.id, "swarm/agent/status", { agentId, status: "active", progress: 0 });

    const done = run.result
      .then((result) => {
        settleAgent(swarm, agentId, result.stopReason === "completed");
        // Parse the outlined plan (prompt-driven: only when outlinePlan asked).
        // Prefer scanning the child's session events — the plan is emitted in an
        // early assistant message, before the tool loop, so the run's final
        // output may not carry it; fall back to the final output.
        if (outlinePlan && result.stopReason === "completed") {
          const outlined = readChildPlan(run.id) ?? parsePlanFromOutput(result.output);
          const entry = agentById(swarm, agentId);
          if (entry && outlined) {
            entry.plan = outlined.map((item, index) => ({
              id: `${agentId}-plan-${index}`,
              title: typeof item?.title === "string" ? item.title : String(item?.title ?? ""),
              status: "done",
              ownerId: agentId,
              ...planWindow(index, outlined.length)
            }));
          }
        }
        writeMarkersForChild(run.id, result.stopReason === "completed");
        // Persist the child's evidence NOW (while its session is still loaded):
        // todos + logs are read live from ctx.sessions, which is garbage-collected
        // after the run, so persisting them here is what keeps the agent's
        // workspace populated for later /swarm/state reads.
        const artifacts = listArtifacts(run.id);
        const todos = readChildTodos(run.id);
        const logs = readChildLogs(run.id);
        {
          const entry = agentById(swarm, agentId);
          if (entry) {
            if (artifacts !== undefined) entry.artifacts = artifacts;
            if (todos !== undefined) entry.todos = todos;
            if (logs !== undefined) entry.logs = logs;
          }
        }
        persist(session.id, swarm);
        maybeResumeMain(session);
        const settled = agentById(swarm, agentId);
        emitSwarmEvent(session.id, "swarm/agent/status", {
          agentId,
          status: settled?.status ?? "error",
          progress: settled?.progress ?? 0
        });
        if (settled?.plan) emitSwarmEvent(session.id, "swarm/agent/plan", { agentId, plan: settled.plan });
        if (swarm.phase === "complete") emitSwarmEvent(session.id, "swarm/phase", { phase: swarm.phase });
      })
      .catch(() => {
        settleAgent(swarm, agentId, false);
        persist(session.id, swarm);
        maybeResumeMain(session);
        emitSwarmEvent(session.id, "swarm/agent/status", { agentId, status: "error", progress: 0 });
      });

    // `done` resolves when the run settles, so confirm can drain waves of
    // `concurrencyLimit` subagents rather than spawning every agent at once.
    return { ok: true, agentId, childId: run.id, done };
  };

  /** Delegate planning to a one-shot subagent and adopt its structured plan. */
  const delegatePlan = async (session, spec) => {
    if (session === undefined) return { ok: false, error: "no_active_session" };
    const subagents = ctx.get("subagents");
    if (subagents === undefined || typeof subagents.start !== "function") {
      return { ok: false, error: "subagent service unavailable" };
    }
    const parent = agentForSession(ctx, session.id);
    if (parent === undefined) return { ok: false, error: "no live agent for session" };

    const provider = cfg.providers.length > 0 ? cfg.providers[0] : defaultProvider(subagents);
    const capabilities = subagents.getProvider(provider)?.capabilities ?? {};
    const objective = typeof spec.objective === "string" ? spec.objective : "";

    let run;
    try {
      run = await subagents.start(provider, {
        label: "swarm-planner",
        prompt: [{ type: "text", text: spec.prompt ?? `Plan the multi-agent orchestration for: ${objective}` }],
        parent,
        signal: AbortSignal.timeout(30 * 60 * 1000),
        ...(capabilities.outputSchema ? { outputSchema: PLAN_SCHEMA } : {})
      });
    } catch (error) {
      return { ok: false, error: `plan delegation failed: ${String(error)}` };
    }

    const result = await run.result;
    let planItems = [];
    if (result.structured && typeof result.structured === "object") {
      planItems = Array.isArray(result.structured.plan) ? result.structured.plan : [];
    }
    if (planItems.length === 0) {
      // Fallback: parse a JSON plan out of the assistant's text output.
      const text = result.output
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      const match = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, text];
      try {
        const parsed = JSON.parse(match[1]);
        planItems = Array.isArray(parsed.plan) ? parsed.plan : parsed;
      } catch {
        // Non-JSON planner output: record nothing structured; caller can read text.
      }
    }
    setPlan(session, planItems, { objective });
    return { ok: true, plan: planItems };
  };

  /**
   * Persist the pre-run orchestration topology (rows 10, 11, 13, 14): canvas
   * positions, delegation/report edges, and per-edge permissions. The UI's
   * OrchestratorBoard edits these before `confirm`; `confirm` then honors them
   * (the roster spawn is unchanged — positions/edges are presentation + the
   * plan's owner assignments drive who actually works on what).
   */
  const setTopology = (session, topology = {}) => {
    if (session === undefined) return { ok: false, error: "no_active_session" };
    const { swarm, save } = touch(session.id);
    if (topology !== null && typeof topology === "object") {
      if (topology.positions !== null && typeof topology.positions === "object") {
        swarm.positions = {};
        for (const [agentId, pos] of Object.entries(topology.positions)) {
          if (pos && Number.isFinite(Number(pos?.x)) && Number.isFinite(Number(pos?.y))) {
            swarm.positions[agentId] = { x: Number(pos.x), y: Number(pos.y) };
          }
        }
      }
      if (Array.isArray(topology.lines)) {
        swarm.lines = topology.lines
          .filter((l) => l && typeof l === "object")
          .map((l) => ({
            from: typeof l.from === "string" ? l.from : "",
            to: typeof l.to === "string" ? l.to : "",
            type: l.type === "delegates" ? "delegates" : "reports"
          }))
          .filter((l) => l.from !== "" && l.to !== "");
      }
      if (topology.permissions !== null && typeof topology.permissions === "object") {
        swarm.permissions = { ...topology.permissions };
      }
      if (Array.isArray(topology.resources)) {
        swarm.resources = topology.resources
          .filter((r) => r && typeof r === "object")
          .map((r) => ({
            id: typeof r.id === "string" ? r.id : randomUUID(),
            name: typeof r.name === "string" ? r.name : "",
            rtype: typeof r.rtype === "string" ? r.rtype : "file",
            ownerId: typeof r.ownerId === "string" ? r.ownerId : "",
            zone: typeof r.zone === "string" ? r.zone : "shared"
          }));
      }
    }
    save();
    return { ok: true, swarm: { ...swarm } };
  };

  // First-class service.
  ctx.provide("swarm", {
    state,
    recruit,
    setPlan,
    setTopology,
    delegatePlan,
    spawn,
    confirm,
    cancel,
    summarize
  });

  // ---------------------------------------------------------------------------
  // Lifecycle → projection. Subagent start/end edges update the roster; a
  // session's own events are mirrored into the store (deferred a microtask to
  // respect the session append re-entrancy guard).
  // ---------------------------------------------------------------------------

  ctx.on("subagent/start", (info) => {
    const mapping = childToRoster.get(info.id);
    if (mapping === undefined) return;
    const { swarm, save } = touch(mapping.sessionId);
    const entry = agentById(swarm, mapping.agentId);
    if (entry) entry.status = "active";
    save();
  });

  ctx.on("subagent/end", (info) => {
    const mapping = childToRoster.get(info.id);
    if (mapping === undefined) return;
    const { swarm, save } = touch(mapping.sessionId);
    settleAgent(swarm, mapping.agentId, info.stopReason === "completed");
    writeMarkersForChild(info.id, info.stopReason === "completed");
    const artifacts = listArtifacts(info.id);
    if (artifacts !== undefined) {
      const entry = agentById(swarm, mapping.agentId);
      if (entry) entry.artifacts = artifacts;
    }
    save();
    maybeResumeMain(ctx.sessions.get(mapping.sessionId));
  });

  ctx.on("session/event", (session, event) => {
    if (event.type === "subagent/start" || event.type === "subagent/end") return; // handled above
    queueMicrotask(() => {
      const swarm = load(session.id);
      closeOut(swarm); // self-heal before mirroring, so the mirror never re-persists a stale state
      persist(session.id, swarm);
    });
  });

  // ---------------------------------------------------------------------------
  // Model-facing context: the current swarm state so the main agent knows its
  // roster, plan, and phase.
  // ---------------------------------------------------------------------------

  ctx.inject(["systemPrompt"], (scope) => {
    scope.systemPrompt.context({
      name: "swarm:state",
      order: 113,
      text: (context) => {
        const session = context.agent?.session;
        if (session === undefined) return "";
        const swarm = state(session);
        if (swarm.agents.length === 0 && swarm.plan.length === 0 && swarm.objective === "") return "";
        const parts = [];
        parts.push(`Active agent-swarm phase: ${swarm.phase}.`);
        if (swarm.objective) parts.push(`Objective: ${swarm.objective}.`);
        if (swarm.agents.length > 0) {
          parts.push(`Roster (${swarm.completedCount}/${swarm.recruitedCount} complete): ${swarm.agents.map((a) => `${a.name} [${a.role}] = ${a.status}`).join(", ")}.`);
        }
        if (swarm.plan.length > 0) {
          parts.push(`Plan: ${swarm.plan.map((p) => `[${p.status}] ${p.title}`).join("; ")}.`);
        }
        return parts.join(" ");
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Slash command: the main agent's in-session control surface.
  // ---------------------------------------------------------------------------

  ctx.inject(["commands"], (scope) => {
    scope.commands.register({
      name: "swarm",
      description: "Recruit, plan, confirm, cancel, or summarize the agent swarm",
      input: { hint: "recruit <name> [role] [task] [--model=X] [--effort=Y] [--outline] [--prompt=ROLE] | plan <title>[@owner] [; ...] [--objective=...] | confirm [--resumeWhenDone] | cancel | summarize <text>" },
      handler: async ({ agent, rawInput }) => {
        const session = agent?.session;
        if (session === undefined) return { kind: "error", text: "no active session" };
        // Extract --key=value flags (values may be quoted) before whitespace
        // splitting, so multi-word flag values (e.g. a role prompt) survive.
        const raw = (rawInput ?? "").trim();
        const flags = {};
        let cleaned = raw;
        const flagRe = /--(\w+)(?:=("[^"]*"|'[^']*'|[^\s]+))?/g;
        let m;
        while ((m = flagRe.exec(raw)) !== null) {
          let value = m[2] === undefined ? true : m[2];
          if (typeof value === "string" && value.length >= 2 && ((value[0] === '"' && value[value.length - 1] === '"') || (value[0] === "'" && value[value.length - 1] === "'"))) {
            value = value.slice(1, -1);
          }
          flags[m[1]] = value;
          cleaned = cleaned.replace(m[0], " ");
        }
        const parts = cleaned.trim().split(/\s+/).filter(Boolean);
        const verb = parts[0] ?? "list";

        if (verb === "list" || verb === "state") {
          const swarm = state(session);
          const roster = swarm.agents.map((a) => `${a.name} [${a.role}] ${a.status} (${a.progress}%)`).join("\n") || "(none)";
          const plan = swarm.plan.map((p) => `[${p.status}] ${p.title}`).join("\n") || "(none)";
          return { kind: "success", text: `phase: ${swarm.phase}\nobjective: ${swarm.objective || "(none)"}\nroster:\n${roster}\nplan:\n${plan}` };
        }
        if (verb === "recruit") {
          // /swarm recruit <name> [role] [task...] [--model=X] [--effort=Y]
          //             [--outline] [--prompt="ROLE PROMPT"]
          const name = parts[1];
          if (!name) return { kind: "error", text: "usage: /swarm recruit <name> [role] [task] [--model=X] [--effort=Y] [--outline] [--prompt=\"ROLE\"]" };
          const spec = { id: name.toLowerCase().replace(/\W+/g, "-"), name };
          if (flags.outline) spec.outlinePlan = true;
          if (typeof flags.model === "string" && flags.model !== "") spec.model = flags.model;
          if (typeof flags.effort === "string" && flags.effort !== "") spec.reasoningEffort = flags.effort;
          if (typeof flags.prompt === "string" && flags.prompt !== "") spec.rolePrompt = flags.prompt;
          spec.role = parts[2] ?? "worker";
          spec.task = parts.slice(3).join(" ");
          const result = recruit(session, [spec]);
          if (!result.ok) return { kind: "error", text: result.error };
          const bits = [`recruited ${name} [${spec.role}]`];
          if (spec.model) bits.push(`model=${spec.model}`);
          if (spec.reasoningEffort) bits.push(`effort=${spec.reasoningEffort}`);
          if (spec.outlinePlan) bits.push("outline");
          if (spec.rolePrompt) bits.push("prompt");
          return { kind: "success", text: `${bits.join(" ")}; phase ${result.swarm.phase}` };
        }
        if (verb === "plan") {
          // /swarm plan <title>[@owner] [; <title>[@owner] ...] [--objective="..."]
          const rest = parts.slice(1).join(" ");
          const items = rest
            .split(/[;|]/)
            .map((s) => s.trim())
            .filter(Boolean)
            .map((title) => {
              const at = title.lastIndexOf("@");
              return {
                id: randomUUID(),
                title: (at >= 0 ? title.slice(0, at) : title).trim(),
                status: "pending",
                ownerId: at >= 0 ? title.slice(at + 1).trim() : null
              };
            });
          if (items.length === 0) return { kind: "error", text: "usage: /swarm plan <title>[@owner] [; <title>...] [--objective=\"...\"]" };
          const objective = typeof flags.objective === "string" ? flags.objective : "";
          const result = setPlan(session, items, objective !== "" ? { objective } : {});
          if (!result.ok) return { kind: "error", text: result.error };
          return { kind: "success", text: `plan set (${items.length} item${items.length > 1 ? "s" : ""}); phase awaiting_confirm` };
        }
        if (verb === "confirm") {
          const resume = flags.resumeWhenDone === true;
          const result = await confirm(session, { resumeMainWhenDone: resume });
          if (!result.ok) return { kind: "error", text: result.error };
          return { kind: "success", text: resume
            ? `swarm confirmed; phase executing; the main agent will be resumed once the swarm completes`
            : `swarm confirmed; phase executing` };
        }
        if (verb === "cancel") {
          const result = await cancel(session);
          if (!result.ok) return { kind: "error", text: result.error };
          return { kind: "success", text: `swarm cancelled; phase recruiting` };
        }
        if (verb === "summarize") {
          const summary = parts.slice(1).join(" ");
          const result = summarize(session, summary);
          if (!result.ok) return { kind: "error", text: result.error };
          return { kind: "success", text: `swarm complete; summary recorded` };
        }
        return { kind: "error", text: `unknown subcommand "${verb}" (use recruit, plan, confirm, cancel, summarize)` };
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Agent-facing tool. The slash command above serves the user in the composer;
  // this `swarm` tool is what the MAIN AGENT actually calls to orchestrate — so
  // a main-agent-driven run (recruit → plan → confirm → summarize) is visible in
  // the session and populates the same projection the web UI renders.
  // ---------------------------------------------------------------------------

  ctx.tools.register({
      name: "swarm",
      description:
        "Orchestrate a team of subagents in the current session. " +
        "Use action=recruit to add subagents — pass the full list in the `agents` array, each with name, role, task, and optional model/reasoningEffort/outlinePlan/rolePrompt — plus an optional `concurrency` integer (max concurrently-running subagents). " +
        "Use action=plan to record the orchestration plan (items with an optional ownerId). " +
        "Use action=confirm to start execution (set resumeMainWhenDone=true to have the plugin wake the main agent once the swarm completes so it reviews the subagents' work), and action=summarize to record the end-of-swarm summary. " +
        "action=state reads the current swarm. Call recruit for ALL agents first, then plan, then confirm, then summarize once the agents finish.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["state", "recruit", "plan", "confirm", "cancel", "summarize"],
            description: "Which swarm operation to perform."
          },
          agents: {
            type: "array",
            description: "For action=recruit: the subagents to recruit.",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "Stable lowercase id (optional; derived from name otherwise)." },
                name: { type: "string", description: "Display name." },
                role: { type: "string", description: "Short role, e.g. frontend / backend / qa." },
                task: { type: "string", description: "The concrete task this subagent should complete." },
                model: { type: "string", description: "Optional model override, e.g. deepseek-v4-flash." },
                reasoningEffort: { type: "string", description: "Optional reasoning effort: off / low / high / max." },
                outlinePlan: { type: "boolean", description: "Ask this subagent to outline a step-by-step plan first." },
                rolePrompt: { type: "string", description: "Optional persona/role prompt for this subagent." }
              },
              required: ["name", "task"]
            }
          },
          plan: {
            type: "array",
            description: "For action=plan: the orchestration plan items.",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                ownerId: { type: "string", description: "Optional id of the agent that owns this item." }
              },
              required: ["title"]
            }
          },
          objective: { type: "string", description: "Optional objective (used with action=plan)." },
          concurrency: { type: "integer", description: "Optional max concurrently-running subagents (used with action=recruit)." },
          summary: { type: "string", description: "For action=summarize: the final one-sentence summary." },
          resumeMainWhenDone: { type: "boolean", description: "For action=confirm: when true, the plugin wakes the main agent once the swarm completes so it reviews the subagents' work (default false)." }
        },
        required: ["action"]
      },
      output: {
        schema: { type: "object" },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }]
      },
      async execute(args, exec) {
        const session = exec?.agent?.session;
        if (session === undefined) return { ok: false, error: "no active session" };
        let result;
        switch (args?.action) {
          case "state":
            result = { ok: true, swarm: state(session) };
            break;
          case "recruit": {
            // Normalize each agent: derive a stable id from its name when absent
            // (same rule as the /swarm command), so plan ownerIds can reference it.
            const list = (Array.isArray(args?.agents) ? args.agents : []).map((a) => ({
              ...a,
              id: typeof a?.id === "string" && a.id !== ""
                ? a.id
                : String(a?.name ?? "").toLowerCase().replace(/\W+/g, "-")
            }));
            result = recruit(session, list, args?.concurrency);
            break;
          }
          case "plan":
            result = setPlan(session, Array.isArray(args?.plan) ? args.plan : [], typeof args?.objective === "string" ? { objective: args.objective } : {});
            break;
          case "confirm":
            result = await confirm(session, { resumeMainWhenDone: args?.resumeMainWhenDone === true });
            break;
          case "cancel":
            result = await cancel(session);
            break;
          case "summarize":
            result = summarize(session, typeof args?.summary === "string" ? args.summary : "");
            break;
          default:
            return { ok: false, error: `unknown action "${args?.action}" (use state, recruit, plan, confirm, cancel, summarize)` };
        }
        if (!result.ok) return { ok: false, error: result.error };
        const swarm = result.swarm ?? result;
        return {
          ok: true,
          phase: swarm.phase,
          objective: swarm.objective || "",
          summary: swarm.summary ?? null,
          roster: (swarm.agents ?? []).map((a) => `${a.name}[${a.role}]=${a.status}`).join(", "),
          plan: (swarm.plan ?? []).map((p) => `[${p.status}]${p.title}`).join(", ")
        };
      }
    });

  // ---------------------------------------------------------------------------
  // Web FE data plane (loopback-only). The client tab polls GET and mutates
  // through POST; the slash command above serves the agent.
  // ---------------------------------------------------------------------------

  ctx.inject(["webServer"], (scope) => {
    const send = (res, code, body) => {
      res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };

    scope.webServer.register({
      kind: "exact",
      path: "/swarm/state",
      handler: async (req, res) => {
        if (!isLoopback(req.socket?.remoteAddress)) {
          return send(res, 403, { ok: false, error: "loopback-only" });
        }

        const url = new URL(req.url ?? "/", "http://localhost");
        const sessionId = url.searchParams.get("session");

        if (req.method === "GET") {
          if (!sessionId) return send(res, 400, { ok: false, error: "missing ?session=<id>" });
          const session = resolveSession(ctx.sessions.get?.(sessionId));
          // `view=latest` → only the latest swarm call's agents (the ideal UI
          // card); otherwise → session-level (the Swarm tab).
          const latest = url.searchParams.get("view") === "latest";
          return send(res, 200, { ok: true, swarm: state(session, latest) });
        }

        if (req.method === "POST") {
          let parsed;
          try {
            parsed = JSON.parse((await readBody(req)) || "{}");
          } catch {
            return send(res, 400, { ok: false, error: "invalid JSON body" });
          }
          const session = resolveSession(ctx.sessions.get?.(parsed?.session));
          if (session === undefined) return send(res, 400, { ok: false, error: "unknown session" });

          const { action } = parsed ?? {};
          let result;
          switch (action) {
            case "recruit":
              result = recruit(session, parsed.agents);
              break;
            case "plan":
              result = setPlan(session, parsed.plan, { objective: parsed.objective });
              break;
            case "confirm":
              result = await confirm(session);
              break;
            case "cancel":
              result = await cancel(session);
              break;
            case "summarize":
              result = summarize(session, parsed.summary);
              break;
            case "spawn":
              result = await spawn(session, parsed);
              break;
            case "delegate-plan":
              result = await delegatePlan(session, parsed);
              break;
            case "topology":
              result = setTopology(session, parsed.topology);
              break;
            default:
              return send(res, 400, { ok: false, error: `unknown action "${action}"` });
          }
          if (!result.ok) return send(res, 400, { ok: false, error: result.error });
          return send(res, 200, { ok: true, swarm: state(session) });
        }

        return send(res, 405, { ok: false, error: "use GET or POST" });
      }
    });

    // Event-driven data plane: SSE stream of swarm events for one session. The
    // browser tab subscribes here instead of polling; each `swarm/event` is
    // pushed as an SSE `data:` frame (same envelope as the JSONL log).
    scope.webServer.register({
      kind: "exact",
      path: "/swarm/events",
      handler: (req, res) => {
        if (!isLoopback(req.socket?.remoteAddress)) {
          res.writeHead(403, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "loopback-only" }));
          return;
        }
        const url = new URL(req.url ?? "/", "http://localhost");
        const sessionId = url.searchParams.get("session");
        if (!sessionId) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "missing ?session=<id>" }));
          return;
        }
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive"
        });
        res.write(": connected\n\n");

        let clients = sseClients.get(sessionId);
        if (clients === undefined) {
          clients = new Set();
          sseClients.set(sessionId, clients);
        }
        clients.add(res);
        const close = () => clients.delete(res);
        req.on("close", close);
        res.on("close", close);
      }
    });

    // Serve the built ideal UI bundle (dsh-agent-swarm-ui/dist) so the web app
    // can embed it on the native DSH origin — no separate host, no core patch.
    scope.webServer.register({
      kind: "prefix",
      path: UI_ROUTE_PREFIX,
      handler: (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const sub = url.pathname === UI_ROUTE_PREFIX ? "" : url.pathname.slice(UI_ROUTE_PREFIX.length);
        serveUiStatic(res, sub);
      }
    });
  });

  ctx.logger?.info(`agent-swarm: store ${store.fileFor("session")} (concurrency ${cfg.concurrencyLimit})`);
}

export { apply, inject, name };
