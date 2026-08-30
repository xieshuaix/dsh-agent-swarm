window.__ModuleLoader__.load({
  id: "dsh-agent-swarm",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");
    var h = React.createElement;

    //#region dsh-agent-swarm/client

    var NS = "dsh-agent-swarm";
    var UI_ROUTE = "/dsh-agent-swarm/ui";

    var DICT_ZH = {
      "tab": "智能体群组",
      "hint": "主智能体招募子智能体、规划编排（或委派规划）、执行并在结束时总结。此面板展示当前会话的编排状态。"
    };
    var DICT_EN = {
      "tab": "Swarm",
      "hint": "The main agent recruits subagents, plans the orchestration (or delegates planning), executes, and summarizes at the end. This panel shows the current session's orchestration state."
    };

    var STYLE = [
      ".das-inline{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px 12px;margin:6px 0}",
      ".das-inline-header{display:flex;align-items:baseline;gap:8px;margin-bottom:8px}",
      ".das-inline-title{font-weight:600;font-size:13px;color:var(--dsw-alias-label-primary)}",
      ".das-inline-sub{color:var(--dsw-alias-label-secondary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}"
    ].join("\n");

    /** Load the embed library (JS + CSS) once; call onReady when mountable. */
    var idealUiReady = false;
    var idealUiWaiters = [];
    function ensureIdealUi(onReady) {
      if (idealUiReady) { onReady(); return; }
      idealUiWaiters.push(onReady);
      if (document.getElementById("das-ideal-css")) return; // already injecting
      var css = document.createElement("link");
      css.rel = "stylesheet";
      css.id = "das-ideal-css";
      css.href = UI_ROUTE + "/ideal-swarm-ui.css";
      document.head.appendChild(css);
      var js = document.createElement("script");
      js.src = UI_ROUTE + "/ideal-swarm-ui.js";
      js.onload = function () {
        idealUiReady = true;
        var ws = idealUiWaiters; idealUiWaiters = [];
        ws.forEach(function (w) { w(); });
      };
      document.head.appendChild(js);
    }

    /** The ideal SwarmPanel (rich agent cards), mounted natively — no iframe. */
    function NativeSwarmView(props) {
      var ref = React.useRef(null);
      var readyState = React.useState(idealUiReady);
      var ready = readyState[0];
      var setReady = readyState[1];
      React.useEffect(function () {
        ensureIdealUi(function () { setReady(true); });
      }, []);
      React.useEffect(function () {
        if (!ready || !ref.current || !window.IdealSwarmUI) return undefined;
        return window.IdealSwarmUI.mount(ref.current, { sessionId: props.sessionId });
      }, [ready, props.sessionId]);
      var style = { width: "100%", overflow: "auto", background: "#0c0d0f" };
      if (props.inline) {
        style.minHeight = "420px";
      } else {
        style.height = "100%";
      }
      return h("div", { ref: ref, style: style });
    }

    // -----------------------------------------------------------------------
    // Inline-in-chat swarm cards: mount the ideal SwarmPanel at the turn where
    // the main agent dispatched the swarm (the first assistant turn that called
    // the `swarm` tool with recruit/plan/confirm). Detection is synchronous off
    // the conversation snapshot (useSession), so no host round-trip decides
    // placement — the panel itself then live-polls /swarm/state as usual.
    // -----------------------------------------------------------------------

    function isSwarmTool(name) {
      return name === "swarm" || /(^|[:/])swarm$/.test(String(name ?? ""));
    }

    function parseSwarmAction(argsRaw) {
      if (typeof argsRaw !== "string" || argsRaw === "") return "";
      try {
        var parsed = JSON.parse(argsRaw);
        return parsed && typeof parsed.action === "string" ? parsed.action : "";
      } catch (e) {
        return "";
      }
    }

    function isDispatchAction(action) {
      return action === "recruit" || action === "plan" || action === "confirm";
    }

    /** First assistant turn whose blocks include a dispatching swarm tool call. */
    function firstSwarmTurn(snapshot) {
      var nodes = snapshot && snapshot.nodes;
      if (!Array.isArray(nodes)) return -1;
      var min = -1;
      for (var i = 0; i < nodes.length; i++) {
        var node = nodes[i];
        if (!node || node.kind !== "assistant") continue;
        var blocks = node.blocks;
        if (!Array.isArray(blocks)) continue;
        for (var j = 0; j < blocks.length; j++) {
          var b = blocks[j];
          if (b && b.kind === "tool-call" && isSwarmTool(b.name) && isDispatchAction(parseSwarmAction(b.argsRaw))) {
            var tn = node.turn;
            if (typeof tn === "number" && (min === -1 || tn < min)) min = tn;
            break;
          }
        }
      }
      return min;
    }

    /** Chain entry body: renders the inline panel only at the dispatch turn. */
    function InlineSwarmTail(props) {
      var matched = props.matched;
      var turnNum = matched && typeof matched.turn === "number" ? matched.turn : -1;
      var useSession = props.useSession;
      var firstTurn = typeof useSession === "function" ? useSession(function (s) { return firstSwarmTurn(s); }) : -1;
      if (turnNum < 0 || firstTurn !== turnNum) return null;
      return h("div", { className: "das-inline" },
        h("div", { className: "das-inline-header" },
          h("span", { className: "das-inline-title" }, props.t ? props.t("tab") : "Swarm"),
          h("span", { className: "das-inline-sub" }, props.t ? props.t("hint") : "")
        ),
        h(NativeSwarmView, { sessionId: props.sessionId, inline: true })
      );
    }

    function apply(ctx) {
      var t = ctx.locale.bind(NS);
      ctx.effect(function () {
        return ctx.locale.register(NS, { zh: DICT_ZH, en: DICT_EN });
      }, "dsh-agent-swarm: dictionaries");

      var style = document.createElement("style");
      style.setAttribute("data-dsh-agent-swarm", "");
      style.textContent = STYLE;
      document.head.appendChild(style);
      ctx.effect(function () {
        return function () { if (style.parentNode) style.parentNode.removeChild(style); };
      }, "dsh-agent-swarm: styles");

      ctx.slots.inject("conversation.view", function () {
        return ctx.slots.register({
          name: "conversation.view",
          id: "swarm",
          order: 35,
          locale: NS,
          label: function () { return t("tab"); }
        }, function (props) {
          return h(NativeSwarmView, props);
        });
      });

      // Inline in the chat: the ideal swarm agent cards mount at the message
      // where the swarm was dispatched. This is a chain seat — select narrows
      // on the turn boundary (it can't see the async swarm state), and the
      // component declines via the synchronous conversation snapshot.
      ctx.slots.inject("conversation.chat.turnTail", function () {
        return ctx.slots.register({
          name: "conversation.chat.turnTail",
          locale: NS,
          select: function (owner) {
            var turn = owner && owner.turn;
            var turnNum = typeof turn === "number" ? turn : (turn && turn.turn);
            return typeof turnNum === "number" ? { turn: turnNum, seq: owner.seq } : null;
          }
        }, function (props) {
          return h(InlineSwarmTail, props);
        });
      });
    }

    //#endregion

    module.exports = {
      name: "dsh-agent-swarm",
      inject: ["slots", "locale"],
      apply,
      __internals: { isSwarmTool, parseSwarmAction, isDispatchAction, firstSwarmTurn }
    };
    return module.exports;
  }
});
