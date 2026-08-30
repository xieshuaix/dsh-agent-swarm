import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { dirname, join } from "node:path";

// The client half (lib/client.js) is a plain browser bundle that registers
// itself on window.__ModuleLoader__.load and pulls React from the frozen module
// table. Load it in a vm sandbox with a stub React and a fake document/ctx to
// verify the functional contract — the primitive "Swarm" tab, and the inline
// ideal card published as a conversation chat node the moment the swarm is
// dispatched.

const BUNDLE_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "client.js");

const ReactStub = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: children.length ? children : undefined } };
  },
  useState(initial) {
    return [initial, () => undefined];
  },
  useEffect() {},
  useRef(initial) {
    return { current: initial };
  },
  useCallback(fn) {
    return fn;
  },
  useReducer(_reducer, initial) {
    return [initial, () => undefined];
  }
};

function makeFakeDocument() {
  const head = { children: [], appendChild(el) { this.children.push(el); } };
  return {
    createElement: () => ({ setAttribute() {}, textContent: "", style: {} }),
    head
  };
}

function loadBundle() {
  const loaded = [];
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(entry) {
          loaded.push(entry);
        }
      }
    },
    document: makeFakeDocument(),
    console
  };
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(BUNDLE_PATH, "utf8"), sandbox);
  assert.equal(loaded.length, 1, "bundle registered exactly one module");

  const require = (id) => {
    if (id === "react") return ReactStub;
    throw new Error(`unexpected require("${id}")`);
  };
  return { module: loaded[0].factory(require), sandbox };
}

function makeFakeCtx() {
  const registered = { locales: [], slots: [], events: [] };
  const ctx = {
    locale: {
      bind: () => (key) => key,
      register: (ns, dict) => registered.locales.push({ ns, dict })
    },
    effect: (fn) => {
      fn();
      return () => undefined;
    },
    slots: {
      inject: (_name, callback) => callback(),
      register: (meta, render) => {
        registered.slots.push({ meta, render });
      }
    },
    conversationEvents: {
      register: (definition) => registered.events.push(definition)
    }
  };
  return { ctx, registered };
}

test("client bundle exports the host-facing contract", () => {
  const { module } = loadBundle();
  assert.equal(module.name, "dsh-agent-swarm");
  assert.equal(module.inject.length, 3);
  assert.equal(module.inject[0], "slots");
  assert.equal(module.inject[1], "locale");
  assert.equal(module.inject[2], "conversationEvents");
  assert.equal(typeof module.apply, "function");
});

test("apply registers dictionaries, the swarm-card conversation node, and the slots", () => {
  const { module } = loadBundle();
  const fake = makeFakeCtx();

  assert.doesNotThrow(() => module.apply(fake.ctx));

  assert.equal(fake.registered.locales.length, 1);
  assert.equal(fake.registered.locales[0].ns, "dsh-agent-swarm");

  assert.equal(fake.registered.events.length, 1);
  assert.equal(fake.registered.events[0].kind, "swarm-card");

  assert.equal(fake.registered.slots.length, 2);
  const view = fake.registered.slots.find((s) => s.meta.name === "conversation.view");
  assert.ok(view, "conversation.view slot registered");
  assert.equal(view.meta.id, "swarm");
  assert.equal(view.meta.label(), "tab"); // t() is the identity stub

  const node = fake.registered.slots.find((s) => s.meta.name === "conversation.chat.node");
  assert.ok(node, "conversation.chat.node slot registered");
  assert.equal(node.meta.key, "swarm-card");
});

test("the conversation.view slot renders the primitive SwarmView for a session", () => {
  const { module } = loadBundle();
  const fake = makeFakeCtx();
  module.apply(fake.ctx);
  const { render } = fake.registered.slots.find((s) => s.meta.name === "conversation.view");

  const element = render({ sessionId: "s1" });
  assert.ok(element, "render returns an element");
  assert.equal(typeof element.type, "function", "renders the primitive SwarmView component");
  assert.equal(element.props.sessionId, "s1");
});

test("the swarm-card node renderer mounts the ideal card", () => {
  const { module } = loadBundle();
  const fake = makeFakeCtx();
  module.apply(fake.ctx);
  const { render } = fake.registered.slots.find((s) => s.meta.name === "conversation.chat.node");

  const element = render({ sessionId: "s1", node: { kind: "swarm-card", data: { turn: 1 } } });
  assert.ok(element, "render returns an element");
  assert.equal(typeof element.type, "function", "renders the SwarmCardNode component");
  // Drive the component body (stub React records elements without running them).
  const inner = element.type(element.props);
  assert.ok(inner, "SwarmCardNode renders the native card");
  assert.equal(inner.props.sessionId, "s1");
  assert.equal(inner.props.inline, true);
});

test("firstSwarmTurn finds the first dispatching swarm tool call", () => {
  const { module } = loadBundle();
  const { firstSwarmTurn } = module.__internals;

  const assistant = (turn, blocks) => ({ kind: "assistant", turn, blocks });
  const call = (name, action) => ({ kind: "tool-call", name, argsRaw: JSON.stringify({ action }) });

  const snapshot = {
    nodes: [
      assistant(1, [call("write", "run")]),
      assistant(2, [call("swarm", "recruit")]),
      assistant(3, [call("swarm", "state")]),
      assistant(4, [call("swarm", "summarize")])
    ]
  };

  assert.equal(firstSwarmTurn(snapshot), 2, "first recruit/plan/confirm turn, not a state read");
  assert.equal(firstSwarmTurn({ nodes: [] }), -1, "empty snapshot has no dispatch turn");
  assert.equal(firstSwarmTurn({}), -1, "missing nodes declines safely");
  assert.equal(firstSwarmTurn(null), -1, "null snapshot declines safely");
});

test("the swarm-card definition matches the dispatch tool call", () => {
  const { module } = loadBundle();
  const { swarmCardDefinition } = module.__internals;
  const { match } = swarmCardDefinition;

  const toolCall = (name, args, turn = 1) => ({ type: "tool/call", seq: 10, data: { name, turn, arguments: JSON.stringify(args) } });

  // match returns objects minted in the vm realm, so assert fields, not deep-equal.
  const recruit = match(toolCall("swarm", { action: "recruit" }));
  assert.equal(recruit.id, "1");
  assert.equal(recruit.role, "start");
  const plan = match(toolCall("swarm", { action: "plan" }));
  assert.equal(plan.id, "1");
  assert.equal(plan.role, "update");
  const confirm = match(toolCall("swarm", { action: "confirm" }));
  assert.equal(confirm.id, "1");
  assert.equal(confirm.role, "update");
  assert.equal(match(toolCall("swarm", { action: "state" })), null, "a state read is not a dispatch");
  assert.equal(match(toolCall("bash", {})), null, "a non-swarm tool does not match");
  assert.equal(match({ type: "assistant/message" }), null, "a non-tool-call event does not match");

  // buildViewNode anchors the card just after the dispatch call, in the message flow.
  const context = {
    key: "swarm-card:1",
    id: "1",
    state: { turn: 1, seq: 10 },
    start: { location: { kind: "turn" } }
  };
  const node = swarmCardDefinition.buildViewNode(context);
  assert.equal(node.kind, "swarm-card");
  assert.equal(node.anchorSeq, 10.1);
  assert.equal(node.data.turn, 1);
});
