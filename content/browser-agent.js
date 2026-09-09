(() => {
  if (window.__qykGenericBrowserAgent) return;
  window.__qykGenericBrowserAgent = true;
  const ids = new WeakMap(), elements = new Map();
  let nextId = 1;
  const clean = value => String(value || "").replace(/\s+/g, " ").trim();
  const visible = el => {
    const r = el?.getBoundingClientRect?.();
    const s = el && getComputedStyle(el);
    return !!(r && r.width > 1 && r.height > 1 && s.visibility !== "hidden" && s.display !== "none" && r.bottom >= 0 && r.top <= innerHeight);
  };
  const elementId = el => {
    if (!ids.has(el)) { ids.set(el, nextId); elements.set(nextId, el); nextId += 1; }
    return ids.get(el);
  };
  const labelOf = el => clean(el.getAttribute("aria-label") || el.getAttribute("title") || el.placeholder ||
    (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.innerText) || el.innerText || el.textContent).slice(0, 240);
  const sensitive = el => /password|密码|验证码|信用卡|银行卡|身份证|护照|cvv|安全码|短信/i.test(
    `${el.type || ""} ${el.name || ""} ${el.id || ""} ${labelOf(el)}`);

  function inspect() {
    const selector = "a,button,input,textarea,select,[role=button],[role=link],[role=option],[contenteditable=true],[tabindex]";
    const rows = [];
    for (const el of document.querySelectorAll(selector)) {
      if (!visible(el) || rows.length >= 100) continue;
      const r = el.getBoundingClientRect();
      const row = {
        id: elementId(el), tag: el.tagName.toLowerCase(), role: el.getAttribute("role") || "",
        label: labelOf(el), type: el.type || "", disabled: !!el.disabled,
        x: Math.round((r.left + r.width / 2) / innerWidth * 1000) / 1000,
        y: Math.round((r.top + r.height / 2) / innerHeight * 1000) / 1000
      };
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") row.value = sensitive(el) ? "[敏感字段]" : clean(el.value).slice(0, 160);
      if (el.tagName === "SELECT") row.options = [...el.options].slice(0, 60).map(o => clean(o.textContent));
      if (el.href) row.href = String(el.href).slice(0, 500);
      rows.push(row);
    }
    return {
      url: location.href, title: document.title,
      text: clean(document.body?.innerText).slice(0, 6500), elements: rows,
      viewport: { width: innerWidth, height: innerHeight, scrollY: Math.round(scrollY), pageHeight: document.documentElement.scrollHeight }
    };
  }

  const setValue = (el, value) => {
    if (el.isContentEditable) {
      el.focus(); el.textContent = value;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      return;
    }
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    setter ? setter.call(el, value) : (el.value = value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };

  async function execute(action) {
    const type = String(action?.type || "");
    if (type === "wait") return new Promise(resolve => setTimeout(() => resolve({ ok: true }), Math.min(5000, Math.max(200, Number(action.ms) || 1000))));
    if (type === "scroll") {
      window.scrollBy({ top: Math.max(-innerHeight * 2, Math.min(innerHeight * 2, Number(action.deltaY) || innerHeight * .8)), behavior: "smooth" });
      return { ok: true };
    }
    const el = elements.get(Number(action.elementId));
    if (!el || !document.contains(el) || !visible(el)) return { ok: false, error: "目标元素已变化，请重新分析页面" };
    if (type === "click") {
      const label = labelOf(el);
      if (/支付|付款|提交订单|确认下单|立即购买|转账|删除账户|注销账户|确认发布|发送验证码/i.test(label)) {
        el.scrollIntoView({ block: "center" });
        return { ok: false, requiresUser: true, message: `“${label || "此按钮"}”属于重要操作，请你在网页中亲自确认并点击。` };
      }
      const href = el.href ? String(el.href) : "";
      const looksDownload = el.hasAttribute("download") || /\.(?:pdf|zip|docx?|xlsx?|pptx?|csv|json|xml|png|jpe?g)(?:$|[?#])/i.test(href);
      el.scrollIntoView({ block: "center" }); el.click();
      return { ok: true, downloadStarted: looksDownload, filename: el.getAttribute("download") || "" };
    }
    if (type === "fill") {
      if (sensitive(el)) return { ok: false, requiresUser: true, message: "密码、验证码、证件或支付信息需要你在网页中亲自填写。" };
      setValue(el, String(action.text || "")); return { ok: true };
    }
    if (type === "select") {
      if (el.tagName !== "SELECT") return { ok: false, error: "目标不是下拉框" };
      const wanted = clean(action.value);
      const option = [...el.options].find(o => o.value === wanted || clean(o.textContent) === wanted || clean(o.textContent).includes(wanted));
      if (!option) return { ok: false, error: "下拉框中没有该选项" };
      el.value = option.value; el.dispatchEvent(new Event("change", { bubbles: true })); return { ok: true };
    }
    if (type === "press") {
      el.focus();
      const key = String(action.key || "Enter");
      el.dispatchEvent(new KeyboardEvent("keydown", { key, code: key, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keyup", { key, code: key, bubbles: true }));
      return { ok: true };
    }
    return { ok: false, error: `不支持的动作：${type}` };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "QYK_BROWSER_INSPECT") { sendResponse(inspect()); return; }
    if (msg?.type === "QYK_BROWSER_EXECUTE") { Promise.resolve(execute(msg.action)).then(sendResponse); return true; }
  });
})();
