(() => {
  if (window.__qykBrowserBridge) return;
  window.__qykBrowserBridge = true;
  const EXT_VERSION = "0.19.4";
  let last = "", lastAt = 0, dismissTimer = 0;
  let progressTimer = 0, progressStarted = 0, progressMessage = "", progressStatus = "", progressHidden = false;

  const versionLt = (a, b) => {
    const x = String(a || "").split(".").map(n => parseInt(n, 10) || 0);
    const y = String(b || "").split(".").map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
    }
    return false;
  };

  async function latestRelease() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1200);
    try {
      const response = await fetch("https://ai.qykaiwu.cn/static/qyk-browser-extension-latest.json?t=" + Date.now(), {
        cache: "no-store", credentials: "omit", signal: controller.signal
      });
      const release = response.ok ? await response.json() : null;
      return release && release.version ? release : null;
    } catch (_) { return null; }
    finally { clearTimeout(timer); }
  }

  function panel() {
    let el = document.getElementById("qyk-browser-status");
    if (el) return el;
    el = document.createElement("div");
    el.id = "qyk-browser-status";
    Object.assign(el.style, {
      position: "fixed", right: "18px", bottom: "88px", zIndex: "2147483647",
      boxSizing: "border-box", maxWidth: "min(360px, calc(100vw - 36px))",
      maxHeight: "min(160px, 40vh)", overflow: "hidden",
      padding: "12px 36px 12px 14px", borderRadius: "12px",
      background: "#111827", color: "white", boxShadow: "0 8px 28px #0004",
      font: "13px/1.5 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif",
      display: "none"
    });
    const close = document.createElement("button");
    close.textContent = "×";
    Object.assign(close.style, { position: "absolute", right: "9px", top: "6px", border: "0", background: "none", color: "#fff", fontSize: "20px", cursor: "pointer" });
    close.onclick = () => { progressHidden = true; el.style.display = "none"; };
    close.setAttribute("aria-label", "关闭提示");
    const text = document.createElement("span");
    Object.assign(text.style, {
      display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: "4",
      overflow: "hidden", overflowWrap: "anywhere"
    });
    el.appendChild(text);
    el.appendChild(close);
    document.documentElement.appendChild(el);
    return el;
  }

  const terminalStatus = status => ["search_complete", "needs_user", "error", "done", "cancelled"].includes(status);
  function progressLabel(message, status, elapsed) {
    const phase = {
      ready: "正在打开目标网页", navigating: "正在等待网页加载", inspecting: "正在读取页面内容",
      planning_required: "正在等待 GPT-6 分析并返回下一步", planning: "正在等待 GPT-6 分析并返回下一步",
      acting: "正在执行网页操作", reconnecting: "网页跳转中，正在重新连接", downloading: "正在等待下载开始"
    }[status] || message || "正在处理浏览器任务";
    const dots = ".".repeat((elapsed % 3) + 1);
    if (elapsed >= 80 && ["planning_required", "planning"].includes(status)) {
      return `${phase}${dots} 已等待 ${elapsed} 秒，正在自动结束本次等待`;
    }
    return elapsed >= 20 ? `${phase}${dots} 已等待 ${elapsed} 秒，仍在处理，并非卡死` : `${phase}${dots} ${elapsed} 秒`;
  }
  function paintProgress() {
    if (progressHidden) return;
    const el = panel();
    let text = el.querySelector("span");
    if (!text) { text = document.createElement("span"); el.insertBefore(text, el.firstChild); }
    const elapsed = Math.max(0, Math.floor((Date.now() - progressStarted) / 1000));
    text.textContent = `⏳ ${progressLabel(progressMessage, progressStatus, elapsed)}`;
    el.style.display = "block";
  }
  function show(message, status) {
    clearTimeout(dismissTimer);
    progressHidden = false;
    const el = panel();
    let text = el.querySelector("span");
    if (!text) { text = document.createElement("span"); el.insertBefore(text, el.firstChild); }
    clearInterval(progressTimer); progressTimer = 0;
    if (!terminalStatus(status) && status !== "accepted") {
      progressStarted = Date.now(); progressMessage = message || ""; progressStatus = status || "";
      paintProgress();
      progressTimer = setInterval(paintProgress, 1000);
      return;
    }
    const summary = String(message || "").replace(/\s+/g, " ").trim();
    text.textContent = `${status === "error" ? "⚠️" : "✈️"} ${summary.length > 180 ? summary.slice(0, 180) + "…" : summary}`;
    el.style.display = "block";
    dismissTimer = setTimeout(() => { el.style.display = "none"; }, 4000);
  }

  async function submit(text, requestId, conversationId, chatContext = []) {
    text = String(text || "").trim();
    if (!text || (text === last && Date.now() - lastAt < 400 && !requestId)) return { accepted: false };
    last = text; lastAt = Date.now();
    // 聊天页不再独占意图判断：每条消息先由插件结合该会话上下文做本地轻量判断。
    const check = await chrome.runtime.sendMessage({
      type: "QYK_BROWSER_SHOULD_HANDLE", text,
      conversationId: conversationId || location.hash.replace(/^#/, ""), chatContext
    }).catch(() => ({ candidate: false }));
    if (!check?.candidate) return { accepted: false, candidate: false };
    // 每次真正启动浏览器任务前都从服务器重新取版本；这样聊天页长期不刷新也能发现新版本。
    const release = await latestRelease();
    if (release && versionLt(EXT_VERSION, release.version)) {
      show(`插件 v${EXT_VERSION} 已过期，最新版是 v${release.version}。请先更新插件。`, "error");
      return {
        accepted: false, candidate: true, unavailable: true, outdated: true,
        currentVersion: EXT_VERSION, latestVersion: String(release.version),
        downloadUrl: String(release.download_url || ""), videoUrl: String(release.video_url || "")
      };
    }
    return chrome.runtime.sendMessage({
      type: "QYK_CHAT_MESSAGE", text,
      conversationId: conversationId || location.hash.replace(/^#/, ""), chatContext
    }).then(r => {
      if (r?.accepted) show("浏览器助手已接管，本条消息不会再交给服务器浏览器。", "accepted");
      return r || { accepted: false };
    }).catch(error => ({ accepted: false, error: String(error) }));
  }

  // 页面主动发起并等待 ACK。旧版监听 click/keydown 会让原聊天和扩展各跑一次，已移除。
  document.addEventListener("qyk-browser-command", async e => {
    const d = e.detail || {};
    const result = await submit(d.text, d.requestId, d.conversationId, d.chatContext);
    document.dispatchEvent(new CustomEvent("qyk-browser-command-result", {
      detail: { requestId: d.requestId, ...result }
    }));
  });

  // 查询“当前会话是否曾由浏览器助手接管”，让不带搜索关键词的追问也能延续原任务。
  document.addEventListener("qyk-browser-context-check", async e => {
    const d = e.detail || {};
    const result = await chrome.runtime.sendMessage({
      type: "QYK_GET_CHAT_TASK", conversationId: String(d.conversationId || "")
    }).catch(() => ({ task: null }));
    document.dispatchEvent(new CustomEvent("qyk-browser-context-result", {
      detail: { requestId: d.requestId, active: !!result?.task }
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
      detail: { version: EXT_VERSION, activeTask: !!r?.task, taskStatus: r?.task?.status || '' }
    }));
  }).catch(() => {
    document.dispatchEvent(new CustomEvent("qyk-browser-ready", { detail: { version: EXT_VERSION, activeTask: false } }));
  });
})();
