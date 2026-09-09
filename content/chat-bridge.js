(() => {
  if (window.__qykBrowserBridge) return;
  window.__qykBrowserBridge = true;
  let last = "", lastAt = 0;

  function panel() {
    let el = document.getElementById("qyk-browser-status");
    if (el) return el;
    el = document.createElement("div");
    el.id = "qyk-browser-status";
    Object.assign(el.style, {
      position: "fixed", right: "18px", bottom: "88px", zIndex: "2147483647",
      maxWidth: "340px", padding: "12px 36px 12px 14px", borderRadius: "12px",
      background: "#111827", color: "white", boxShadow: "0 8px 28px #0004",
      font: "13px/1.5 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif",
      display: "none"
    });
    const close = document.createElement("button");
    close.textContent = "×";
    Object.assign(close.style, { position: "absolute", right: "9px", top: "6px", border: "0", background: "none", color: "#fff", fontSize: "20px", cursor: "pointer" });
    close.onclick = () => { el.style.display = "none"; };
    el.appendChild(close);
    document.documentElement.appendChild(el);
    return el;
  }

  function show(message, status) {
    const el = panel();
    let text = el.querySelector("span");
    if (!text) { text = document.createElement("span"); el.insertBefore(text, el.firstChild); }
    text.textContent = `${status === "error" ? "⚠️" : "✈️"} ${message}`;
    el.style.display = "block";
  }

  async function submit(text, requestId, conversationId) {
    text = String(text || "").trim();
    if (!text || (text === last && Date.now() - lastAt < 400 && !requestId)) return { accepted: false };
    last = text; lastAt = Date.now();
    return chrome.runtime.sendMessage({
      type: "QYK_CHAT_MESSAGE", text,
      conversationId: conversationId || location.hash.replace(/^#/, "")
    }).then(r => {
      if (r?.accepted) show("浏览器助手已接管，本条消息不会再交给服务器浏览器。", "accepted");
      return r || { accepted: false };
    }).catch(error => ({ accepted: false, error: String(error) }));
  }

  // 页面主动发起并等待 ACK。旧版监听 click/keydown 会让原聊天和扩展各跑一次，已移除。
  document.addEventListener("qyk-browser-command", async e => {
    const d = e.detail || {};
    const result = await submit(d.text, d.requestId, d.conversationId);
    document.dispatchEvent(new CustomEvent("qyk-browser-command-result", {
      detail: { requestId: d.requestId, ...result }
    }));
  });

  chrome.runtime.onMessage.addListener(msg => {
    if (msg?.type === "QYK_STATUS") {
      show(msg.message || msg.status, msg.status);
      document.dispatchEvent(new CustomEvent("qyk-browser-status", { detail: msg }));
    }
  });

  document.addEventListener("qyk-browser-plan-result", e => {
    chrome.runtime.sendMessage({ type: "QYK_BROWSER_PLAN_RESULT", ...(e.detail || {}) }).catch(() => {});
  });
  const conversationId = location.hash.replace(/^#/, "");
  chrome.runtime.sendMessage({ type: "QYK_GET_CHAT_TASK", conversationId }).then(r => {
    document.dispatchEvent(new CustomEvent("qyk-browser-ready", {
      detail: { version: "0.10.0", activeTask: !!r?.task }
    }));
  }).catch(() => {
    document.dispatchEvent(new CustomEvent("qyk-browser-ready", { detail: { version: "0.10.0", activeTask: false } }));
  });
})();
