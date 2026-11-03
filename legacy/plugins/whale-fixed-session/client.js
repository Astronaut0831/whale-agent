window.__ModuleLoader__.load({
  id: "@whale/whale-fixed-session",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const name = "whale-fixed-session";
    const inject = ["uiWorkspace"];

    const TARGET_SESSION = String(globalThis.__WHALE_TARGET_SESSION__ || "");

    function apply(ctx, config = {}) {
      // Client entries do not receive the host plugin config; keep the one fixed id here.
      const target = TARGET_SESSION;
      if (!target) return;

      let done = false;
      let timer = null;
      let attempts = 0;
      let missingLogged = false;
      const startedAt = Date.now();
      const GUARD_MS = 12000;
      const stop = () => {
        if (timer) { clearInterval(timer); timer = null; }
      };

      const tryOpen = () => {
        if (done) return;
        const elapsed = Date.now() - startedAt;
        const ws = ctx.uiWorkspace || ctx.get("uiWorkspace");
        if (!ws || !ws.sessions || !ws.workspaces) return;
        const sessions = ws.sessions.list.getSnapshot();
        const workspaces = ws.workspaces.list.getSnapshot();
        if (!sessions || !workspaces) return;
        if (sessions.phase !== "ready" || workspaces.phase !== "ready") return;
        if (!sessions.byId || !sessions.byId[target]) {
          if (!missingLogged && elapsed > 5000) {
            missingLogged = true;
            console.error("[whale-fixed-session] target session is missing:", target);
          }
          return;
        }

        const current = Object.values(sessions.byId).find((row) => (row.retainedBy?.mainView ?? 0) > 0);
        if (current && current.id === target) {
          // Keep guarding for a while: restoreSelection may run after this and switch back.
          if (elapsed >= GUARD_MS) {
            done = true;
            stop();
          }
          return;
        }
        if (elapsed >= GUARD_MS || attempts >= 60) { stop(); return; }
        attempts += 1;
        try { ws.openSession(target); } catch { /* retry on next tick */ }
      };

      timer = setInterval(tryOpen, 300);
      ctx.effect(() => {
        const offs = [];
        const ws = ctx.uiWorkspace || ctx.get("uiWorkspace");
        if (ws) {
          try { offs.push(ws.sessions.list.subscribe(tryOpen)); } catch { /* ignore */ }
          try { offs.push(ws.workspaces.list.subscribe(tryOpen)); } catch { /* ignore */ }
        }
        return () => {
          stop();
          for (const off of offs) { try { off(); } catch { /* ignore */ } }
        };
      }, "whale-fixed-session: open target on boot");
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
