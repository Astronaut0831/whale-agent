window.__ModuleLoader__.load({
  id: "@whale/whale-gui-input",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const name = "whale-gui-input";
    const inject = ["conversation"];
    const ENDPOINT = "http://127.0.0.1:8788/api/gui/input";

    async function route(text) {
      try {
        const r = await fetch(ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: String(text || "") }),
          signal: AbortSignal.timeout(150000),
        });
        if (!r.ok) return false;
        const d = await r.json().catch(() => null);
        return Boolean(d && d.ok === true);
      } catch {
        return false;
      }
    }

    function apply(ctx) {
      try {
        const conv = ctx.conversation || ctx.get("conversation");
        if (!conv || !conv.send || conv.__whaleGuiInputWrapped) return;
        const originalSend = conv.send.bind(conv);
        const originalSendSession = typeof conv.sendSession === "function" ? conv.sendSession.bind(conv) : null;

        conv.send = async function whaleGuiSend(text) {
          if (await route(text)) return;
          return originalSend(text);
        };
        if (originalSendSession) {
          conv.sendSession = async function whaleGuiSendSession(session, text, attachmentIds, mode, signal) {
            if ((!attachmentIds || attachmentIds.length === 0) && await route(text)) return;
            return originalSendSession(session, text, attachmentIds, mode, signal);
          };
        }
        conv.__whaleGuiInputWrapped = true;
      } catch (e) {
        console.error("[whale-gui-input] wrap failed; direct GUI send remains", e);
      }
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
