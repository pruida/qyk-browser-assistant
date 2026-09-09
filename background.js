const TASK_KEY = "activeTask";
const MAX_STEPS = 16;
const planningTaskIds = new Set();
const applyingPlanIds = new Set();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const getTask = async () => (await chrome.storage.local.get(TASK_KEY))[TASK_KEY] || null;
const saveTask = task => chrome.storage.local.set({ [TASK_KEY]: task });
const quickHash = value => {
  let hash = 2166136261;
  for (const ch of String(value || "")) { hash ^= ch.codePointAt(0); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(36);
};
const safeFilename = (name, url = "") => {
  let value = String(name || "").split(/[\\/]/).pop().replace(/[<>:"|?*\u0000-\u001f]/g, "_").trim();
  if (!value) {
    try { value = decodeURIComponent(new URL(url).pathname.split("/").pop()) || "下载文件"; } catch (_) { value = "下载文件"; }
  }
  return value.slice(0, 180);
};

const isTerminal = status => ["cancelled", "error"].includes(status);
const turnStopped = status => ["search_complete", "needs_user", "cancelled", "error"].includes(status);
const browserIntent = text => {
  const t = String(text || "").trim();
  return /https?:\/\//i.test(t) ||
    /(?:打开|访问|进入|浏览|操作|点击|填写|上传|下载|登录|注册|预订|订票|订房|下单|购买|比价|搜索|搜一下|查一下|查询).{0,24}(?:网站|网页|官网|页面|携程|淘宝|天猫|京东|百度|知乎|微博|航班|酒店|商品|订单)/.test(t) ||
    /(?:在|用).{0,18}(?:网站|官网|携程|淘宝|天猫|京东|百度|知乎|微博).{0,18}(?:找|查|搜|买|订|填|打开|操作)/.test(t) ||
    /帮我.{0,30}(?:打开|查|搜|买|订|定|填|登录|下载|上传)/.test(t);
};

async function tellChat(task, status, message, activate = false, extra = {}) {
  if (!task?.sourceTabId) return;
  try { await chrome.tabs.sendMessage(task.sourceTabId, { type: "QYK_STATUS", status, message, task, ...extra }); } catch (_) {}
  if (activate) try { await chrome.tabs.update(task.sourceTabId, { active: true }); } catch (_) {}
}

async function ensureTarget(task) {
  if (task.targetTabId) {
    try { await chrome.tabs.get(task.targetTabId); return task.targetTabId; } catch (_) {}
  }
  const tab = await chrome.tabs.create({ url: "about:blank", active: true });
  task.targetTabId = tab.id;
  await saveTask(task);
  return tab.id;
}

async function pageState(task) {
  const tab = await chrome.tabs.get(task.targetTabId);
  if (!/^https?:/i.test(tab.url || "")) {
    return { url: tab.url || "about:blank", title: tab.title || "", text: "", elements: [], viewport: {} };
  }
  let page;
  try {
    page = await chrome.tabs.sendMessage(task.targetTabId, { type: "QYK_BROWSER_INSPECT" });
  } catch (_) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: task.targetTabId }, files: ["content/browser-agent.js"] });
      page = await chrome.tabs.sendMessage(task.targetTabId, { type: "QYK_BROWSER_INSPECT" });
    } catch (_) {
      page = { url: tab.url || "", title: tab.title || "", text: "页面脚本尚未就绪", elements: [], viewport: {} };
    }
  }
  // DOM 足够时走快速模式；只在页面几乎读不到内容时启用视觉截图。
  let screenshot = "";
  const needsVision = String(page?.text || "").length < 240 || (page?.elements || []).length < 2;
  if (needsVision) try {
    await chrome.tabs.update(task.targetTabId, { active: true });
    screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 58 });
  } catch (_) {}
  return { ...page, screenshot };
}

async function requestPlan(task) {
  if (planningTaskIds.has(task.id)) return;
  planningTaskIds.add(task.id);
  try {
    const current = await getTask();
    if (!current || current.id !== task.id || turnStopped(current.status)) return;
    if (["inspecting", "planning"].includes(current.status) && Date.now() - (current.planRequestedAt || 0) < 90000) return;
    task = current;
    if ((task.steps || 0) >= MAX_STEPS) {
      task.status = "needs_user";
      task.lastMessage = `已执行 ${MAX_STEPS} 步，为避免失控已暂停。请补充更具体的要求后继续。`;
      await saveTask(task);
      return tellChat(task, task.status, task.lastMessage, true);
    }
    const exhaustive = /(?:所有|全部|尽可能完整|尽可能多|\ball\b|\bevery\b)/i.test(String(task.goal || ""));
    const researchEnough = !exhaustive && (task.memory || []).length >= 10 && (task.steps || 0) >= 6;
    task.forceFinalize = (task.steps || 0) >= MAX_STEPS - 1 || researchEnough;
    task.status = "inspecting";
    task.planId = crypto.randomUUID();
    task.planRequestedAt = Date.now();
    await saveTask(task);
    const page = await pageState(task);
    const latest = await getTask();
    if (!latest || latest.id !== task.id || latest.planId !== task.planId || turnStopped(latest.status)) return;
    latest.status = "planning";
    latest.pageUrl = page.url;
    latest.pageFingerprint = quickHash(JSON.stringify([
      page.url, page.title, String(page.text || "").slice(0, 8000),
      (page.elements || []).slice(0, 120).map(x => [x.tag, x.label, x.href, x.value]), page.viewport?.scrollY
    ]));
    latest.updatedAt = Date.now();
    await saveTask(latest);
    await tellChat(latest, "planning_required", page.screenshot ? "GPT-6 正在视觉分析当前网页…" : "GPT-6 正在快速读取当前网页…", false, {
      planId: latest.planId, page: { ...page, screenshot: undefined }, screenshot: page.screenshot || ""
    });
  } finally {
    planningTaskIds.delete(task.id);
  }
}

async function afterAction(task, message = "页面已更新，正在继续分析…") {
  // 点击可能刚刚打开了新标签页。始终以存储中的最新任务为准，不能用调用方的旧对象
  // 把 tabs.onCreated 已写入的新 targetTabId 覆盖回去。
  const current = await getTask();
  if (!current || current.id !== task.id || turnStopped(current.status)) return;
  current.steps = (current.steps || 0) + 1;
  current.actionFailures = 0;
  current.status = "acting";
  current.lastMessage = message;
  current.updatedAt = Date.now();
  await saveTask(current);
  await tellChat(current, "acting", message);
  await sleep(80);
  const latest = await getTask();
  if (!latest || latest.id !== task.id || turnStopped(latest.status)) return;
  const tab = await chrome.tabs.get(latest.targetTabId);
  if (tab.status === "loading") {
    latest.status = "navigating";
    await saveTask(latest);
    return;
  }
  await requestPlan(latest);
}

async function recoverPageConnection(task) {
  let latest = await getTask();
  if (!latest || latest.id !== task.id || turnStopped(latest.status)) return;
  latest.status = "reconnecting";
  latest.lastMessage = "目标网页正在跳转，浏览器助手正在自动重新连接…";
  latest.updatedAt = Date.now();
  await saveTask(latest);
  await tellChat(latest, "acting", latest.lastMessage);

  for (const delay of [100, 250, 500, 900, 1500]) {
    await sleep(delay);
    latest = await getTask();
    if (!latest || latest.id !== task.id || turnStopped(latest.status)) return;
    let tab;
    try { tab = await chrome.tabs.get(latest.targetTabId); } catch (_) { continue; }
    if (!/^https?:/i.test(tab.url || "")) {
      latest.status = "needs_user";
      latest.lastMessage = `当前页面 ${tab.url || ""} 受 Chrome 限制，无法自动操作。请打开普通网站页面后说“继续”。`;
      await saveTask(latest);
      return tellChat(latest, "needs_user", latest.lastMessage, true, { sourceUrl: tab.url || "" });
    }
    if (tab.status === "loading") continue;
    try {
      await chrome.scripting.executeScript({ target: { tabId: latest.targetTabId }, files: ["content/browser-agent.js"] });
      const probe = await chrome.tabs.sendMessage(latest.targetTabId, { type: "QYK_BROWSER_INSPECT" });
      if (!probe?.url) continue;
      latest.status = "acting";
      latest.lastMessage = "已重新连接网页，正在根据最新页面继续分析…";
      latest.updatedAt = Date.now();
      await saveTask(latest);
      await tellChat(latest, "acting", latest.lastMessage);
      return requestPlan(latest); // 页面可能已经变化，丢弃旧动作并重新规划，避免点错元素。
    } catch (_) {}
  }
  latest = await getTask();
  if (!latest || latest.id !== task.id || turnStopped(latest.status)) return;
  latest.status = "needs_user";
  latest.lastMessage = "暂时无法连接目标网页。请切到目标页确认页面已加载完成或完成登录/验证，然后回到聊天发送“继续”。";
  await saveTask(latest);
  return tellChat(latest, "needs_user", latest.lastMessage, true, { sourceUrl: latest.pageUrl || "" });
}

async function recoverActionFailure(task, reason) {
  let latest = await getTask();
  if (!latest || latest.id !== task.id || turnStopped(latest.status)) return;
  latest.actionFailures = (latest.actionFailures || 0) + 1;
  const history = latest.actionHistory || [];
  if (history.length) history[history.length - 1].outcome = `失败：${String(reason || "页面状态已变化").slice(0, 300)}`;
  latest.actionHistory = history;
  latest.steps = (latest.steps || 0) + 1;
  if (latest.actionFailures >= 3) {
    latest.status = "needs_user";
    latest.lastMessage = `网页连续 ${latest.actionFailures} 次拒绝操作，本轮已安全暂停。请检查是否需要登录或验证，然后发送“继续”。`;
    await saveTask(latest);
    return tellChat(latest, "needs_user", latest.lastMessage, true, { sourceUrl: latest.pageUrl || "" });
  }
  latest.status = "acting";
  latest.lastMessage = `当前操作不可用（${String(reason || "页面已变化").slice(0, 120)}），正在读取最新页面并改用其他路径…`;
  await saveTask(latest);
  await tellChat(latest, "acting", latest.lastMessage);
  await sleep(150);
  latest = await getTask();
  if (!latest || latest.id !== task.id || turnStopped(latest.status)) return;
  return requestPlan(latest);
}

async function applyPlan(task, plan) {
  if (!plan || typeof plan !== "object") {
    task.planFailures = (task.planFailures || 0) + 1;
    if (task.planFailures <= 2) {
      task.status = "acting";
      task.lastMessage = `规划服务暂时没有返回有效结果，正在自动重试（${task.planFailures}/2）…`;
      await saveTask(task);
      await tellChat(task, "acting", task.lastMessage);
      await sleep(900 * task.planFailures);
      const retryTask = await getTask();
      if (!retryTask || retryTask.id !== task.id || turnStopped(retryTask.status)) return;
      return requestPlan(retryTask);
    }
    task.status = "needs_user";
    task.lastMessage = "规划服务暂时不可用，本轮已暂停且不会重复执行。请稍后发送“继续”重试。";
    await saveTask(task);
    return tellChat(task, "needs_user", task.lastMessage, true);
  }
  task.planFailures = 0;
  const additions = Array.isArray(plan.memory_append) ? plan.memory_append.slice(0, 20) : [];
  const memory = Array.isArray(task.memory) ? task.memory : [];
  for (const item of additions) {
    if (!item || typeof item !== "object") continue;
    const key = String(item.url || item.id || item.title || JSON.stringify(item)).slice(0, 1000);
    if (!memory.some(x => String(x.url || x.id || x.title || JSON.stringify(x)).slice(0, 1000) === key)) memory.push(item);
  }
  task.memory = memory.slice(-24);
  const status = String(plan.status || "continue");
  const message = String(plan.message || plan.result || "浏览器任务状态已更新。").slice(0, 12000);
  if (status === "done") {
    task.status = "search_complete";
    task.lastMessage = message;
    await saveTask(task);
    return tellChat(task, task.status, message, true, { result: plan.result || message, sourceUrl: task.pageUrl || "" });
  }
  if (status === "needs_user") {
    task.status = "needs_user";
    task.lastMessage = message;
    await saveTask(task);
    return tellChat(task, task.status, message, true, { result: plan.result || "", sourceUrl: task.pageUrl || "" });
  }
  const action = plan.action || {};
  const type = String(action.type || "");
  const signature = JSON.stringify([task.pageFingerprint || task.pageUrl || "", type, action.url || "", action.elementId || "", action.text || action.value || action.key || ""]);
  if (["navigate", "click", "fill", "select", "press", "back", "download"].includes(type) &&
      (task.actionHistory || []).some(x => x.taskId === task.id && x.signature === signature)) {
    if (type === "download") {
      task.status = "needs_user";
      task.lastMessage = "已阻止同一文件的重复下载。";
      await saveTask(task);
      return tellChat(task, "needs_user", task.lastMessage, true, { sourceUrl: task.pageUrl || "" });
    }
    return recoverActionFailure(task, "页面内容没有变化，已跳过模型给出的重复动作");
  }
  task.actionHistory = [...(task.actionHistory || []), {
    step: task.steps || 0, pageUrl: task.pageUrl || "", type,
    target: action.url || action.elementId || "", message, signature, taskId: task.id
  }].slice(-16);
  if (type === "download") {
    let url;
    try { url = new URL(String(action.url || "")); } catch (_) { throw new Error("下载地址无效"); }
    if (!/^https?:$/.test(url.protocol)) throw new Error("只允许下载 HTTP/HTTPS 文件");
    const filename = safeFilename(action.filename, url.href);
    const downloadKey = `${url.href}|${filename}`;
    if ((task.downloadKeys || []).includes(downloadKey)) {
      task.status = "needs_user";
      task.lastMessage = `已阻止重复下载“${filename}”。`;
      await saveTask(task);
      return tellChat(task, "needs_user", task.lastMessage, true);
    }
    task.downloadKeys = [...(task.downloadKeys || []), downloadKey].slice(-20);
    task.status = "downloading";
    await saveTask(task);
    const downloadId = await chrome.downloads.download({ url: url.href, filename, conflictAction: "uniquify", saveAs: false });
    task.status = "search_complete";
    task.lastMessage = `已开始下载“${filename}”，本轮操作已结束，不会重复下载。`;
    task.downloadId = downloadId;
    await saveTask(task);
    return tellChat(task, "search_complete", task.lastMessage, true, { result: task.lastMessage, sourceUrl: task.pageUrl || "" });
  }
  if (type === "navigate") {
    let url;
    try { url = new URL(String(action.url || "")); } catch (_) { throw new Error("模型给出的网页地址无效"); }
    if (!/^https?:$/.test(url.protocol)) throw new Error("只允许打开 HTTP/HTTPS 网页");
    task.status = "navigating";
    task.lastMessage = message || `正在打开 ${url.hostname}…`;
    task.steps = (task.steps || 0) + 1;
    task.actionFailures = 0;
    await saveTask(task);
    await tellChat(task, "navigating", task.lastMessage);
    await chrome.tabs.update(task.targetTabId, { url: url.href, active: true });
    return;
  }
  if (type === "back") {
    task.status = "navigating";
    task.steps = (task.steps || 0) + 1;
    await saveTask(task);
    try {
      await chrome.tabs.goBack(task.targetTabId);
      task.actionFailures = 0;
      await saveTask(task);
    } catch (e) {
      return recoverActionFailure(task, e?.message || "当前标签页没有可后退的历史页面");
    }
    return;
  }
  let result;
  if (action.filename) {
    task.pendingFilename = safeFilename(action.filename);
    await saveTask(task);
  }
  try {
    result = await chrome.tabs.sendMessage(task.targetTabId, { type: "QYK_BROWSER_EXECUTE", action });
  } catch (_) {
    return recoverPageConnection(task);
  }
  if (result?.requiresUser) {
    task.status = "needs_user";
    task.lastMessage = result.message || "这一步需要你在网页中亲自确认。";
    await saveTask(task);
    return tellChat(task, "needs_user", task.lastMessage, true, { sourceUrl: task.pageUrl || "" });
  }
  if (!result?.ok) return recoverActionFailure(task, result?.error || "网页动作执行失败");
  if (result.downloadStarted) {
    task.status = "search_complete";
    task.lastMessage = `已开始下载${result.filename ? `“${result.filename}”` : "文件"}，本轮操作已结束，不会重复下载。`;
    await saveTask(task);
    return tellChat(task, "search_complete", task.lastMessage, true, { result: task.lastMessage, sourceUrl: task.pageUrl || "" });
  }
  await afterAction(task, message);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg?.type === "QYK_CHAT_MESSAGE") {
      const old = await getTask();
      const conversationId = String(msg.conversationId || "");
      const sameChat = old && old.conversationId === conversationId && old.sourceTabId === sender.tab?.id && !isTerminal(old.status);
      const text = String(msg.text || "").trim();
      if (sameChat && /^(?:取消|停止|结束|不做了|算了)(?:浏览器|这个任务|操作)?/.test(text)) {
        old.status = "cancelled";
        old.updatedAt = Date.now();
        await saveTask(old);
        await tellChat(old, "cancelled", "浏览器任务已取消。", true);
        return sendResponse({ accepted: true, task: old });
      }
      if (!sameChat && !browserIntent(text)) return sendResponse({ accepted: false });
      const legacyGoal = sameChat && !old.goal ?
        `在携程处理机票任务：${old.from || ""}到${old.to || ""}，${old.departDate || ""}，${old.cabin || ""}，${old.preference || ""}` : "";
      const task = {
        ...(sameChat ? old : {}),
        id: crypto.randomUUID(),
        sessionId: sameChat ? (old.sessionId || old.id) : crypto.randomUUID(),
        kind: "browser",
        goal: sameChat ? (old.goal || legacyGoal || old.instruction || text) : text,
        instruction: text,
        turns: [...(sameChat ? (old.turns || []) : []), { text, at: Date.now() }].slice(-12),
        sourceTabId: sender.tab.id,
        sourceUrl: sender.tab.url,
        conversationId,
        status: "ready",
        steps: 0,
        memory: sameChat ? (old.memory || []) : [],
        actionHistory: sameChat ? (old.actionHistory || []) : [],
        downloadKeys: [],
        pendingFilename: "",
        planFailures: 0,
        actionFailures: 0,
        targetTabId: sameChat ? (old.targetTabId || old.ctripTabId) : undefined,
        updatedAt: Date.now()
      };
      await saveTask(task);
      await ensureTarget(task);
      await tellChat(task, "ready", "通用浏览器助手已接管，正在理解任务…");
      await requestPlan(task);
      return sendResponse({ accepted: true, task });
    }
    if (msg?.type === "QYK_BROWSER_PLAN_RESULT") {
      const initial = await getTask();
      const planId = msg.planId || initial?.planId; // 兼容更新前已打开、尚未刷新的聊天页。
      if (!initial || msg.taskId !== initial.id || planId !== initial.planId || initial.status !== "planning" || applyingPlanIds.has(planId)) {
        return sendResponse({ ok: false, stale: true });
      }
      applyingPlanIds.add(planId);
      try {
        initial.status = "applying";
        await saveTask(initial); // 在执行前落锁，重复/过期规划结果即使同时返回也不会被执行。
        const task = initial;
        await applyPlan(task, msg.plan);
        return sendResponse({ ok: true });
      } catch (e) {
        const task = await getTask();
        if (!task || task.id !== initial.id) return sendResponse({ ok: false, stale: true });
        task.status = "error";
        task.lastMessage = `浏览器操作暂停：${e.message || e}`;
        await saveTask(task);
        await tellChat(task, "error", task.lastMessage, true);
        return sendResponse({ ok: false, error: task.lastMessage });
      } finally { applyingPlanIds.delete(planId); }
    }
    if (msg?.type === "QYK_GET_TASK") return sendResponse({ task: await getTask() });
    if (msg?.type === "QYK_GET_CHAT_TASK") {
      const task = await getTask();
      const conversationId = String(msg.conversationId || "");
      if (!task || task.conversationId !== conversationId || isTerminal(task.status)) return sendResponse({ task: null });
      task.sourceTabId = sender.tab?.id;
      task.sourceUrl = sender.tab?.url || task.sourceUrl;
      await saveTask(task);
      return sendResponse({ task });
    }
    if (msg?.type === "QYK_CANCEL_TASK") {
      const task = await getTask();
      if (task) { task.status = "cancelled"; await saveTask(task); await tellChat(task, "cancelled", "浏览器任务已取消。", true); }
      return sendResponse({ ok: true });
    }
    if (msg?.type === "QYK_RETRY_VISION") {
      const task = await getTask();
      if (!task?.targetTabId) return sendResponse({ ok: false, error: "没有进行中的浏览器任务" });
      await requestPlan(task);
      return sendResponse({ ok: true });
    }
  })().catch(async e => {
    const task = await getTask();
    if (task) await tellChat(task, "error", `浏览器助手异常：${e.message || e}`, true);
    try { sendResponse({ ok: false, error: String(e?.message || e) }); } catch (_) {}
  });
  return true;
});

chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  const task = await getTask();
  if (!task || task.targetTabId !== tabId || isTerminal(task.status)) return;
  if (info.status === "loading") {
    task.status = "navigating";
    await saveTask(task);
    await tellChat(task, "navigating", "网页正在加载…");
    return;
  }
  if (info.status === "complete" && task.status === "navigating") {
    await sleep(80);
    await requestPlan(task);
  }
});

chrome.tabs.onCreated.addListener(async tab => {
  const task = await getTask();
  if (!task || tab.openerTabId !== task.targetTabId || isTerminal(task.status)) return;
  task.targetTabId = tab.id;
  task.status = "navigating";
  await saveTask(task);
});

chrome.downloads.onCreated.addListener(async item => {
  const task = await getTask();
  if (!task || turnStopped(task.status) || !["planning", "acting", "downloading"].includes(task.status)) return;
  let samePage = false;
  try { samePage = !item.referrer || new URL(item.referrer).origin === new URL(task.pageUrl || "").origin; } catch (_) {}
  if (!samePage) return;
  task.status = "search_complete";
  task.downloadId = item.id;
  task.lastMessage = `检测到文件下载已开始，本轮操作已结束，不会再次点击下载。`;
  await saveTask(task);
  await tellChat(task, "search_complete", task.lastMessage, true, { result: task.lastMessage, sourceUrl: task.pageUrl || "" });
});

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  getTask().then(task => {
    let samePage = false;
    try { samePage = !item.referrer || new URL(item.referrer).origin === new URL(task?.pageUrl || "").origin; } catch (_) {}
    if (task?.pendingFilename && samePage && !isTerminal(task.status)) suggest({ filename: safeFilename(task.pendingFilename), conflictAction: "uniquify" });
    else suggest();
  }).catch(() => suggest());
  return true;
});
