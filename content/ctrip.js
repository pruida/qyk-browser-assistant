(() => {
  if (window.__qykCtripAgent) return;
  window.__qykCtripAgent = true;
  let runningId = null;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const visible = el => !!(el && el.getClientRects().length && getComputedStyle(el).visibility !== "hidden");
  const status = (task, state, message, extra = {}) => chrome.runtime.sendMessage({ type: "QYK_CTRIP_STATUS", taskId: task.id, status: state, message, ...extra });
  const clean = s => String(s || "").replace(/\s+/g, " ").trim();

  function setInput(el, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter ? setter.call(el, value) : (el.value = value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function inputBy(words) {
    return [...document.querySelectorAll("input")].find(el => visible(el) && words.some(w =>
      `${el.placeholder || ""} ${el.getAttribute("aria-label") || ""} ${el.name || ""}`.includes(w)));
  }

  async function fillAutocomplete(el, value) {
    el.focus(); setInput(el, ""); setInput(el, value); await sleep(900);
    const choice = [...document.querySelectorAll("li,[role=option],.item,.city-item")]
      .find(x => visible(x) && x.textContent.includes(value));
    if (choice) choice.click(); else el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
    await sleep(350);
  }

  function listUrl(task) {
    if (!task.fromCode || !task.toCode || task.tripType === "roundtrip") return null;
    const cabin = { economy: "y", premium_economy: "s", business: "c", first: "f" }[task.cabin] || "y_s_c_f";
    return `https://flights.ctrip.com/online/list/oneway-${task.fromCode}-${task.toCode}?depdate=${encodeURIComponent(task.departDate)}&cabin=${cabin}`;
  }

  function flightCandidates() {
    const selectors = [
      "[class*=flight-item]", "[class*=flightItem]", "[class*=flight_list_item]",
      "[class*=list-item]", "[class*=listItem]", "article", "li"
    ];
    const nodes = [...new Set(selectors.flatMap(s => [...document.querySelectorAll(s)]))];
    const found = [];
    for (const card of nodes) {
      if (!visible(card)) continue;
      const text = clean(card.innerText);
      const times = [...text.matchAll(/(?:^|\s)([0-2]?\d:[0-5]\d)(?=\s|$)/g)].map(m => m[1]);
      const prices = [...text.matchAll(/[¥￥]\s*(\d{2,6})/g)].map(m => Number(m[1]));
      if (times.length < 2 || !prices.length || text.length > 1800) continue;
      const button = [...card.querySelectorAll("button,a")].find(el => visible(el) && /订票|预订|选择/.test(clean(el.textContent)));
      const flightNo = (text.match(/\b[A-Z0-9]{2}\s?\d{3,4}\b/) || [])[0] || "";
      const airports = [...text.matchAll(/[\u4e00-\u9fa5A-Za-z]{2,14}(?:机场|航站楼)/g)].map(m => m[0]).slice(0, 2);
      const key = `${flightNo}|${times[0]}|${times[1]}|${Math.min(...prices)}`;
      if (found.some(x => x.key === key)) continue;
      found.push({
        key, card, button, flightNo, departTime: times[0], arriveTime: times[1],
        price: Math.min(...prices), fromAirport: airports[0] || "", toAirport: airports[1] || "",
        direct: !/中转|经停/.test(text), summary: text.slice(0, 360)
      });
    }
    return found;
  }

  const publicFlight = f => ({
    flightNo: f.flightNo, departTime: f.departTime, arriveTime: f.arriveTime,
    price: f.price, fromAirport: f.fromAirport, toAirport: f.toAirport,
    direct: f.direct, summary: f.summary
  });

  async function waitForFlights() {
    for (let i = 0; i < 30; i++) {
      const flights = flightCandidates();
      if (flights.length) return flights;
      await sleep(1000);
    }
    return [];
  }

  function chooseCandidate(task, flights) {
    let choices = flights.filter(x => x.button);
    // “选第二个”按聊天中展示的价格升序列表解释，不依赖上一次偏好。
    if (task.choiceIndex) {
      choices.sort((a, b) => a.price - b.price);
      return choices[task.choiceIndex - 1] || null;
    }
    if (task.preference === "direct") {
      const direct = choices.filter(x => x.direct);
      if (direct.length) choices = direct;
    }
    if (task.preference === "cheapest") choices.sort((a, b) => a.price - b.price);
    if (task.preference === "earliest") choices.sort((a, b) => a.departTime.localeCompare(b.departTime));
    return choices[0] || null;
  }

  async function selectCandidate(task, candidate) {
    if (!candidate?.button) return false;
    candidate.card.scrollIntoView({ block: "center", behavior: "instant" });
    await sleep(250);
    candidate.button.click();
    await sleep(900);
    // 只展开/选择舱位，不点击提交订单、支付或任何包含“确认”的按钮。
    const second = [...candidate.card.querySelectorAll("button,a")]
      .find(el => visible(el) && /^(预订|选择)$/.test(clean(el.textContent)));
    if (second && second !== candidate.button) second.click();
    return true;
  }

  async function run(task) {
    if (!task || task.missing?.length || task.status === "cancelled" || runningId === task.id) return;
    runningId = task.id;
    try {
      await status(task, "navigating", "已连接携程页面，正在读取航班结果…");
      const direct = listUrl(task);
      const currentUrl = new URL(location.href);
      const desiredUrl = direct ? new URL(direct) : null;
      if (direct && (!location.href.includes(`oneway-${task.fromCode}-${task.toCode}`) ||
          currentUrl.searchParams.get("depdate") !== task.departDate ||
          currentUrl.searchParams.get("cabin") !== desiredUrl.searchParams.get("cabin"))) {
        await status(task, "navigating", `正在打开 ${task.from} 到 ${task.to} 的航班列表…`);
        location.href = direct;
        return;
      }
      if (!/\/online\/list\//.test(location.pathname)) {
        const from = inputBy(["出发城市", "出发地", "From"]);
        const to = inputBy(["到达城市", "目的地", "To"]);
        const date = inputBy(["出发日期", "Depart"]);
        if (!from || !to || !date) throw new Error("未找到携程机票搜索框，页面可能已改版");
        await fillAutocomplete(from, task.from);
        await fillAutocomplete(to, task.to);
        date.focus(); setInput(date, task.departDate); date.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        const search = [...document.querySelectorAll("button,a")].find(el => visible(el) && /搜索|查询/.test(el.textContent.trim()));
        if (!search) throw new Error("未找到搜索按钮");
        search.click();
        await status(task, "navigating", "搜索条件已填写，正在查询航班…");
        return;
      }
      const internalFlights = await waitForFlights();
      if (!internalFlights.length) {
        const pageText = clean(document.body?.innerText).slice(0, 16000);
        // 零条记录不等于“无航班”：可能是加载慢、登录墙或 DOM 改版，交给视觉兜底判定。
        await status(task, "vision_required", "没有从页面结构中读到可靠航班数据。", { domText: pageText });
        return;
      }
      const flights = internalFlights.map(publicFlight).sort((a, b) => a.price - b.price).slice(0, 20);
      const choice = (task.preference || task.choiceIndex) ? chooseCandidate(task, internalFlights) : null;
      const selected = choice ? await selectCandidate(task, choice) : false;
      if (selected) {
        await status(task, "needs_user", `已读取 ${flights.length} 个航班，并按偏好选择 ¥${choice.price} 的候选。请确认航班和乘机人信息；扩展不会提交订单或支付。`,
          { flights, selected: publicFlight(choice), sourceUrl: location.href });
      } else {
        await status(task, "search_complete", `已从携程页面读取 ${flights.length} 个航班，当前最低可见价 ¥${flights[0].price}。`,
          { flights, sourceUrl: location.href });
      }
    } catch (e) {
      await status(task, "error", `携程自动操作暂停：${e.message || e}`);
    } finally {
      runningId = null;
    }
  }

  chrome.runtime.onMessage.addListener(msg => {
    if (msg?.type === "QYK_RUN_CTRIP") run(msg.task);
    if (msg?.type === "QYK_APPLY_VISION") {
      (async () => {
        const task = msg.task, result = msg.result || {};
        const point = result.recommended || null;
        let clicked = false;
        if ((task?.preference || task?.choiceIndex) && point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
          const x = Math.round(innerWidth * point.x), y = Math.round(innerHeight * point.y);
          const el = document.elementFromPoint(x, y);
          if (el && /订票|预订|选择/.test(clean(el.textContent))) { el.click(); clicked = true; }
        }
        const flights = Array.isArray(result.flights) ? result.flights.slice(0, 20) : [];
        await status(task, clicked ? "needs_user" : "search_complete",
          clicked ? "GPT-6 视觉已定位并选择候选航班，请人工核对后继续。" : "GPT-6 视觉已读取结果页，请在聊天中查看识别结果并人工核对。",
          { flights, selected: result.selected || null, vision: true, sourceUrl: location.href });
      })();
    }
  });
  chrome.runtime.sendMessage({ type: "QYK_GET_TASK" }).then(r => {
    if (r?.task && r.task.ctripTabId && !r.task.missing?.length) run(r.task);
  }).catch(() => {});
})();
