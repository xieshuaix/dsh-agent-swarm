window.__ModuleLoader__.load({
  id: "dsh-agent-swarm",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    var React = require("react");
    var h = React.createElement;

    //#region dsh-agent-swarm/client

    var NS = "dsh-agent-swarm";
    var STATE_PATH = "/swarm/state";
    var POLL_MS = 1500;
    var UI_ROUTE = "/dsh-agent-swarm/ui";

    var DICT_ZH = {
      "tab": "智能体群组",
      "tabIdeal": "理想界面",
      "loading": "加载中…",
      "empty": "暂无群组编排",
      "error": "加载失败",
      "phase": "阶段",
      "objective": "目标",
      "roster": "成员",
      "plan": "计划",
      "summary": "总结",
      "confirm": "确认并执行",
      "cancel": "取消",
      "confirming": "确认中…",
      "cancelling": "取消中…",
      "noObjective": "（无）",
      "noSummary": "（尚未总结）",
      "recruited": "已招募",
      "complete": "已完成",
      "logs": "日志",
      "artifacts": "产物",
      "todos": "待办",
      "systemPrompt": "系统提示",
      "agentsMd": "AGENTS.md",
      "wave": "波次",
      "topology": "拓扑",
      "resources": "资源",
      "lines": "连接",
      "mode_discrete": "离散",
      "mode_continuous": "连续",
      "status_recruiting": "招募中",
      "status_queued": "排队中",
      "status_active": "执行中",
      "status_complete": "完成",
      "status_error": "出错",
      "status_pending": "待处理",
      "status_in_progress": "进行中",
      "status_done": "完成",
      "phase_recruiting": "招募",
      "phase_planning": "规划",
      "phase_awaiting_confirm": "待确认",
      "phase_executing": "执行中",
      "phase_complete": "完成",
      "hint": "主智能体招募子智能体、规划编排（或委派规划）、执行并在结束时总结。此面板展示当前会话的编排状态。"
    };
    var DICT_EN = {
      "tab": "Swarm",
      "tabIdeal": "Ideal UI",
      "loading": "Loading…",
      "empty": "No swarm yet",
      "error": "Failed to load",
      "phase": "Phase",
      "objective": "Objective",
      "roster": "Roster",
      "plan": "Plan",
      "summary": "Summary",
      "confirm": "Confirm & run",
      "cancel": "Cancel",
      "confirming": "Confirming…",
      "cancelling": "Cancelling…",
      "noObjective": "(none)",
      "noSummary": "(not summarized yet)",
      "recruited": "recruited",
      "complete": "complete",
      "logs": "Logs",
      "artifacts": "Artifacts",
      "todos": "Todos",
      "systemPrompt": "System prompt",
      "agentsMd": "AGENTS.md",
      "wave": "Wave",
      "topology": "Topology",
      "resources": "Resources",
      "lines": "Links",
      "mode_discrete": "discrete",
      "mode_continuous": "continuous",
      "status_recruiting": "recruiting",
      "status_queued": "queued",
      "status_active": "active",
      "status_complete": "complete",
      "status_error": "error",
      "status_pending": "pending",
      "status_in_progress": "in progress",
      "status_done": "done",
      "phase_recruiting": "recruiting",
      "phase_planning": "planning",
      "phase_awaiting_confirm": "awaiting confirm",
      "phase_executing": "executing",
      "phase_complete": "complete",
      "hint": "The main agent recruits subagents, plans the orchestration (or delegates planning), executes, and summarizes at the end. This panel shows the current session's orchestration state."
    };

    var STYLE = [
      ".das-root{box-sizing:border-box;height:100%;color:var(--dsw-alias-label-primary);padding:16px 20px 32px;font-size:13px;overflow-y:auto}",
      ".das-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;margin-bottom:14px;padding:14px 16px}",
      ".das-title{font-weight:600;margin-bottom:8px}",
      ".das-hint{color:var(--dsw-alias-label-secondary);font-size:12px;margin-bottom:12px}",
      ".das-empty{color:var(--dsw-alias-label-secondary);text-align:center;padding:18px 0}",
      ".das-error{color:var(--dsw-alias-state-error-primary)}",
      ".das-kv{display:flex;gap:8px;margin-bottom:4px}",
      ".das-kv:last-child{margin-bottom:0}",
      ".das-kv-label{color:var(--dsw-alias-label-secondary);flex:none;min-width:72px;font-size:12px}",
      ".das-kv-value{color:var(--dsw-alias-label-primary);min-width:0;word-break:break-word;font-size:12px}",
      ".das-badge{display:inline-block;border:1px solid var(--dsw-alias-border-l1);border-radius:4px;padding:0 8px;font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary)}",
      ".das-badge-active{color:var(--dsw-alias-state-business-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-business-primary) 40%, transparent)}",
      ".das-badge-done{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-success-primary) 40%, transparent)}",
      ".das-badge-error{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent)}",
      ".das-list{display:flex;flex-direction:column;gap:6px;margin-top:8px}",
      ".das-row{display:flex;align-items:center;gap:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;background:var(--dsw-alias-bg-layer-2)}",
      ".das-row-main{flex:1;min-width:0}",
      ".das-row-name{font-weight:600;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".das-row-meta{color:var(--dsw-alias-label-secondary);font-size:11px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".das-bar{height:4px;border-radius:2px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;margin-top:6px}",
      ".das-bar-fill{height:100%;background:var(--dsw-alias-state-business-primary);border-radius:2px;transition:width .3s}",
      ".das-actions{display:flex;gap:8px;margin-top:10px}",
      ".das-btn{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;cursor:pointer;padding:6px 14px;font-size:12px;font-family:inherit}",
      ".das-btn:hover{border-color:var(--dsw-alias-label-primary)}",
      ".das-btn:disabled{cursor:default;opacity:.6}",
      ".das-btn-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border-color:transparent}",
      ".das-btn-danger{color:var(--dsw-alias-state-error-primary)}",
      ".das-summary{white-space:pre-wrap;color:var(--dsw-alias-label-primary);font-size:12px;margin-top:8px}",
      ".das-detail{margin-top:6px;display:flex;flex-direction:column;gap:4px}",
      ".das-role{color:var(--dsw-alias-label-secondary);font-size:11px;white-space:pre-wrap;word-break:break-word}",
      ".das-todo{display:flex;align-items:flex-start;gap:6px;font-size:11px;color:var(--dsw-alias-label-primary)}",
      ".das-todo-mark{flex:none;width:12px}",
      ".das-todo-done{color:var(--dsw-alias-label-secondary);text-decoration:line-through}",
      ".das-plan-item{display:flex;gap:6px;font-size:11px;align-items:center}",
      ".das-artifact{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all}",
      ".das-log{display:flex;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-word}",
      ".das-log-tool{color:var(--dsw-alias-state-business-primary);flex:none}",
      ".das-sysprompt{white-space:pre-wrap;color:var(--dsw-alias-label-secondary);font-size:11px;word-break:break-word;max-height:120px;overflow-y:auto}",
      ".das-dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex:none;margin-right:2px}",
      ".das-tag{display:inline-block;border-radius:4px;padding:0 6px;font-size:10px;line-height:16px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);margin-left:6px}",
      ".das-inline{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px 12px;margin:6px 0}",
      ".das-inline-header{display:flex;align-items:baseline;gap:8px;margin-bottom:8px}",
      ".das-inline-title{font-weight:600;font-size:13px;color:var(--dsw-alias-label-primary)}",
      ".das-inline-sub{color:var(--dsw-alias-label-secondary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}"
    ].join("\n");

    var PHASE_BADGE = {
      recruiting: "das-badge",
      planning: "das-badge das-badge-active",
      awaiting_confirm: "das-badge das-badge-active",
      executing: "das-badge das-badge-active",
      complete: "das-badge das-badge-done"
    };

    var STATUS_BADGE = {
      recruiting: "das-badge",
      queued: "das-badge",
      active: "das-badge das-badge-active",
      complete: "das-badge das-badge-done",
      error: "das-badge das-badge-error",
      pending: "das-badge",
      in_progress: "das-badge das-badge-active",
      done: "das-badge das-badge-done"
    };

    function SwarmView(props) {
      var sessionId = props.sessionId;
      var t = props.t;
      var viewState = React.useState({ status: "loading", swarm: null });
      var view = viewState[0];
      var setView = viewState[1];
      var busyState = React.useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];

      var load = React.useCallback(function () {
        fetch(STATE_PATH + "?session=" + encodeURIComponent(sessionId), { headers: { accept: "application/json" } })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data && data.ok === true && data.swarm) setView({ status: "ok", swarm: data.swarm });
            else setView({ status: "error", message: (data && data.error) || t("error") });
          })
          .catch(function (err) {
            setView({ status: "error", message: String((err && err.message) || err) });
          });
      }, [sessionId, t]);

      // Debounce event-driven refreshes so a burst of swarm events coalesces
      // into one state fetch.
      var loadTimer = null;
      var scheduleLoad = function () {
        if (loadTimer !== null) return;
        loadTimer = setTimeout(function () {
          loadTimer = null;
          load();
        }, 100);
      };

      React.useEffect(function () {
        load();
        if (!sessionId) return undefined;
        // Primary: server-sent events push updates as they happen.
        var es = null;
        if (typeof EventSource !== "undefined") {
          es = new EventSource("/swarm/events?session=" + encodeURIComponent(sessionId));
          es.onmessage = function () { scheduleLoad(); };
        }
        // Fallback: a slow poll in case SSE is unavailable or drops.
        var timer = setInterval(load, POLL_MS * 10);
        return function () {
          if (es) es.close();
          clearInterval(timer);
          if (loadTimer !== null) clearTimeout(loadTimer);
        };
      }, [load, sessionId]);

      var act = function (action, extra) {
        setBusy(true);
        var body = { session: sessionId, action: action };
        if (extra) for (var k in extra) body[k] = extra[k];
        return fetch(STATE_PATH, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data && data.ok === true && data.swarm) setView({ status: "ok", swarm: data.swarm });
            else setView({ status: "error", message: (data && data.error) || t("error") });
          })
          .catch(function (err) {
            setView({ status: "error", message: String((err && err.message) || err) });
          })
          .finally(function () { setBusy(false); });
      };

      if (view.status === "loading") {
        return h("div", { className: "das-root" }, h("div", { className: "das-card" }, h("div", { className: "das-empty" }, t("loading"))));
      }
      if (view.status === "error") {
        return h("div", { className: "das-root" }, h("div", { className: "das-card" }, h("div", { className: "das-empty das-error" }, view.message)));
      }

      var swarm = view.swarm || { phase: "recruiting", objective: "", plan: [], agents: [], summary: null, recruitedCount: 0, completedCount: 0 };
      var phase = swarm.phase || "recruiting";
      var agents = swarm.agents || [];
      var plan = swarm.plan || [];

      var canConfirm = phase === "awaiting_confirm" || phase === "planning";
      var canCancel = phase === "executing" || phase === "awaiting_confirm" || phase === "planning";

      function kv(label, value) {
        if (value === null || value === undefined || value === "") return null;
        return h("div", { className: "das-kv" },
          h("span", { className: "das-kv-label" }, label),
          h("span", { className: "das-kv-value" }, value)
        );
      }

      /** Render one agent's prompt-driven extras (role prompt, todos, plan, artifacts, logs, systemPrompt, agentsMd). */
      function agentDetail(a) {
        var parts = [];
        function section(labelKey, children) {
          parts.push(h("div", { key: labelKey },
            h("div", { className: "das-kv-label" }, t(labelKey)),
            children
          ));
        }
        if (a.rolePrompt) {
          parts.push(h("div", { className: "das-role", key: "role" }, a.rolePrompt));
        }
        if (typeof a.systemPrompt === "string" && a.systemPrompt !== "") {
          section("systemPrompt", h("div", { className: "das-sysprompt" }, a.systemPrompt));
        }
        if (typeof a.agentsMd === "string" && a.agentsMd !== "") {
          section("agentsMd", h("div", { className: "das-sysprompt" }, a.agentsMd));
        }
        if (Array.isArray(a.plan) && a.plan.length > 0) {
          section("plan", a.plan.map(function (p) {
            return h("div", { className: "das-plan-item", key: p.id },
              h("span", { className: STATUS_BADGE[p.status] || "das-badge" }, t("status_" + (p.status || "pending"))),
              h("span", null, p.title)
            );
          }));
        }
        if (Array.isArray(a.todos) && a.todos.length > 0) {
          section("todos", a.todos.map(function (td) {
            return h("div", { className: "das-todo" + (td.done ? " das-todo-done" : ""), key: td.id },
              h("span", { className: "das-todo-mark" }, td.done ? "✓" : "○"),
              h("span", null, td.text)
            );
          }));
        }
        if (Array.isArray(a.artifacts) && a.artifacts.length > 0) {
          section("artifacts", a.artifacts.map(function (art) {
            return h("div", { className: "das-artifact", key: art.id },
              art.artifactType ? h("span", { className: "das-log-tool" }, "[" + art.artifactType + "] ") : null,
              art.path || art.name
            );
          }));
        }
        if (Array.isArray(a.logs) && a.logs.length > 0) {
          section("logs", a.logs.map(function (lg) {
            return h("div", { className: "das-log", key: lg.id },
              h("span", { className: "das-log-tool" }, lg.type === "action" ? "▸" : lg.type === "result" ? "◂" : "·"),
              lg.tool ? h("span", { className: "das-log-tool" }, lg.tool + ": ") : null,
              h("span", null, lg.content)
            );
          }));
        }
        return parts.length > 0 ? h("div", { className: "das-detail" }, parts) : null;
      }

      return h("div", { className: "das-root" },
        h("div", { className: "das-card" },
          h("div", { className: "das-title" }, t("tab")),
          h("div", { className: "das-hint" }, t("hint")),
          kv(t("phase"), h("span", { className: PHASE_BADGE[phase] || "das-badge" }, t("phase_" + phase))),
          kv(t("objective"), swarm.objective || t("noObjective")),
          kv(t("recruited"), String(swarm.recruitedCount || 0)),
          kv(t("complete"), String(swarm.completedCount || 0)),

          (canConfirm || canCancel) ? h("div", { className: "das-actions" },
            canConfirm ? h("button", { className: "das-btn das-btn-primary", type: "button", disabled: busy, onClick: function () { act("confirm"); } }, busy ? t("confirming") : t("confirm")) : null,
            canCancel ? h("button", { className: "das-btn das-btn-danger", type: "button", disabled: busy, onClick: function () { act("cancel"); } }, busy ? t("cancelling") : t("cancel")) : null
          ) : null
        ),

        agents.length > 0 ? h("div", { className: "das-card" },
          h("div", { className: "das-title" }, t("roster")),
          h("div", { className: "das-list" }, agents.map(function (a) {
            var metaText = (a.role || "") + (a.task ? " — " + a.task : "");
            var modeTag = a.progressMode === "discrete"
              ? h("span", { className: "das-tag" }, t("mode_discrete"))
              : null;
            var waveTag = (typeof a.wave === "number" && a.wave > 0)
              ? h("span", { className: "das-tag" }, t("wave") + " " + a.wave)
              : null;
            var modelTag = (typeof a.model === "string" && a.model !== "")
              ? h("span", { className: "das-tag" }, a.model + (typeof a.reasoningEffort === "string" && a.reasoningEffort !== "" ? "/" + a.reasoningEffort : ""))
              : null;
            return h("div", { className: "das-row", key: a.id },
              h("div", { className: "das-row-main" },
                h("div", { className: "das-row-name" },
                  a.color ? h("span", { className: "das-dot", style: { background: a.color } }) : null,
                  a.name,
                  modeTag,
                  waveTag,
                  modelTag
                ),
                h("div", { className: "das-row-meta" }, metaText),
                h("div", { className: "das-bar" }, h("div", { className: "das-bar-fill", style: { width: (a.progress || 0) + "%" } })),
                agentDetail(a)
              ),
              h("span", { className: STATUS_BADGE[a.status] || "das-badge" }, t("status_" + (a.status || "recruiting")))
            );
          }))
        ) : null,

        plan.length > 0 ? h("div", { className: "das-card" },
          h("div", { className: "das-title" }, t("plan")),
          h("div", { className: "das-list" }, plan.map(function (p) {
            return h("div", { className: "das-row", key: p.id },
              h("div", { className: "das-row-main" },
                h("div", { className: "das-row-name" }, p.title),
                h("div", { className: "das-row-meta" }, p.ownerId || "")
              ),
              h("span", { className: STATUS_BADGE[p.status] || "das-badge" }, t("status_" + (p.status || "pending")))
            );
          }))
        ) : null,

        ((Array.isArray(swarm.resources) && swarm.resources.length > 0) || (Array.isArray(swarm.lines) && swarm.lines.length > 0)) ? h("div", { className: "das-card" },
          h("div", { className: "das-title" }, t("topology")),
          (Array.isArray(swarm.resources) && swarm.resources.length > 0) ? h("div", { className: "das-detail" },
            h("div", { className: "das-kv-label" }, t("resources") + " · " + swarm.resources.length),
            swarm.resources.map(function (r) {
              return h("div", { className: "das-artifact", key: r.id }, "[" + (r.rtype || "file") + "] " + r.name);
            })
          ) : null,
          (Array.isArray(swarm.lines) && swarm.lines.length > 0) ? h("div", { className: "das-detail" },
            h("div", { className: "das-kv-label" }, t("lines") + " · " + swarm.lines.length),
            swarm.lines.map(function (l) {
              return h("div", { className: "das-log", key: l.from + "-" + l.to + "-" + l.type }, l.from + " " + (l.type === "delegates" ? "→" : "←") + " " + l.to + " (" + l.type + ")");
            })
          ) : null
        ) : null,

        (phase === "complete" || swarm.summary) ? h("div", { className: "das-card" },
          h("div", { className: "das-title" }, t("summary")),
          h("div", { className: "das-summary" }, swarm.summary || t("noSummary"))
        ) : null
      );
    }

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

    /** The ideal SwarmPanel (rich, interactive agent cards), mounted natively. */
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
      // A centered card (720px), not a full-width strip. The background is
      // transparent so the embed's own card (theme-adaptive) shows through.
      var style = { width: "100%", maxWidth: "720px", margin: "0 auto", overflow: "auto", background: "transparent" };
      if (props.inline) {
        style.minHeight = "420px";
      } else {
        style.height = "100%";
      }
      return h("div", { ref: ref, className: "das-swarm-card", style: style });
    }

    // -----------------------------------------------------------------------
    // Inline-in-chat swarm card: mount the ideal SwarmPanel at the turn where
    // the main agent dispatched the swarm (the first assistant turn that called
    // the `swarm` tool with recruit/plan/confirm). The card is fully interactive
    // (agent detail popup, canvas, tasks/percent toggle) via the embed library.
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

    /**
     * Conversation node Definition: publish the ideal swarm card inline in the
     * message flow the moment the swarm is DISPATCHED (the `swarm` tool's
     * `recruit` call) — during the turn, not at turn end. The card then
     * live-updates via its own /swarm/state poll.
     */
    var swarmCardDefinition = {
      kind: "swarm-card",
      target: "chat",
      match: function (event) {
        if (event.type !== "tool/call") return null;
        if (event.data && event.data.name !== "swarm") return null;
        var action = "";
        try { action = JSON.parse(event.data && event.data.arguments ? event.data.arguments : "{}").action || ""; } catch (e) { action = ""; }
        if (action === "recruit") {
          return { id: String(event.data.turn), role: "start" };
        }
        if (action === "plan" || action === "confirm") {
          return { id: String(event.data.turn), role: "update" };
        }
        return null;
      },
      start: function (_context, match) {
        return { turn: match.event.data.turn, seq: match.event.seq };
      },
      update: function (context) {
        return context.state;
      },
      publication: function () { return "immediate"; },
      buildViewNode: function (context) {
        if (context.state === void 0) return null;
        return {
          key: context.key,
          kind: "swarm-card",
          id: context.id,
          target: "chat",
          anchorSeq: context.state.seq + 0.1,
          location: context.start && context.start.location ? context.start.location : { kind: "unresolved" },
          visibility: "visible",
          data: { turn: context.state.turn }
        };
      }
    };

    /** Keyed chat-node renderer for the swarm-card node kind. */
    function SwarmCardNode(props) {
      return h(NativeSwarmView, { sessionId: props.sessionId, inline: true });
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
          return h(SwarmView, Object.assign({}, props, { t: t }));
        });
      });

      // Inline in the conversation: publish the ideal swarm card as a chat node
      // the moment the swarm is dispatched (the `recruit` tool call), so it
      // appears in the message flow (middle of the conversation, like a chat or
      // think block) and live-updates from recruiting onward.
      ctx.conversationEvents.register(swarmCardDefinition);
      ctx.slots.inject("conversation.chat.node", function () {
        return ctx.slots.register({
          name: "conversation.chat.node",
          key: "swarm-card",
          locale: NS
        }, function (props) {
          return h(SwarmCardNode, props);
        });
      });
    }

    //#endregion

    module.exports = {
      name: "dsh-agent-swarm",
      inject: ["slots", "locale", "conversationEvents"],
      apply,
      __internals: { isSwarmTool, parseSwarmAction, isDispatchAction, firstSwarmTurn, swarmCardDefinition }
    };
    return module.exports;
  }
});
