const CITY_CODES = {
  北京: "BJS", 上海: "SHA", 广州: "CAN", 深圳: "SZX", 成都: "CTU",
  重庆: "CKG", 杭州: "HGH", 南京: "NKG", 武汉: "WUH", 西安: "SIA",
  天津: "TSN", 长沙: "CSX", 厦门: "XMN", 昆明: "KMG", 青岛: "TAO",
  郑州: "CGO", 三亚: "SYX", 海口: "HAK", 哈尔滨: "HRB", 沈阳: "SHE",
  大连: "DLC", 济南: "TNA", 福州: "FOC", 南昌: "KHN", 宁波: "NGB",
  无锡: "WUX", 温州: "WNZ", 珠海: "ZUH", 贵阳: "KWE", 南宁: "NNG",
  兰州: "LHW", 乌鲁木齐: "URC", 呼和浩特: "HET", 合肥: "HFE", 太原: "TYN",
  石家庄: "SJW", 长春: "CGQ", 银川: "INC", 拉萨: "LXA", 香港: "HKG",
  澳门: "MFM", 台北: "TPE"
};

const pad = n => String(n).padStart(2, "0");
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function parseDate(text, now = new Date()) {
  let m = text.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = text.match(/(?<!\d)(\d{1,2})月(\d{1,2})日?/);
  if (m) {
    const d = new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2]));
    if (d < new Date(now.getFullYear(), now.getMonth(), now.getDate())) d.setFullYear(d.getFullYear() + 1);
    return iso(d);
  }
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (/大后天/.test(text)) d.setDate(d.getDate() + 3);
  else if (/后天/.test(text)) d.setDate(d.getDate() + 2);
  else if (/明天|明日/.test(text)) d.setDate(d.getDate() + 1);
  else if (/今天|今日/.test(text)) d.setDate(d.getDate());
  else return null;
  return iso(d);
}

function cityPair(text) {
  const names = Object.keys(CITY_CODES).sort((a, b) => b.length - a.length);
  const cities = names.join("|");
  const m = text.match(new RegExp(`(?:从|由)?(${cities})(?:出发)?\\s*(?:到|去|飞往|飞)\\s*(${cities})`));
  if (m) return [m[1], m[2]];
  const known = names.map(name => ({ name, at: text.indexOf(name) })).filter(x => x.at >= 0).sort((a, b) => a.at - b.at);
  return known.length >= 2 ? [known[0].name, known[1].name] : [null, null];
}

export function parseFlightMessage(text, previous = null, now = new Date()) {
  text = String(text || "").trim();
  const starts = /携程/.test(text) && /(订|定|买|查|搜).{0,5}(机票|航班)|(机票|航班).{0,5}(订|定|买|查|搜)/.test(text);
  if (!starts && !previous) return null;
  const task = { ...(previous || {}), kind: "flight", provider: "ctrip" };
  const [from, to] = cityPair(text);
  let searchChanged = false;
  if (from) { searchChanged ||= task.from !== from; task.from = from; }
  if (to) { searchChanged ||= task.to !== to; task.to = to; }
  const date = parseDate(text, now);
  if (date) { searchChanged ||= task.departDate !== date; task.departDate = date; }
  if (/往返|来回|返程/.test(text)) task.tripType = "roundtrip";
  else if (/单程/.test(text)) task.tripType = "oneway";
  task.tripType ||= "oneway";
  if (/最便宜|最低价|价格最低/.test(text)) task.preference = "cheapest";
  else if (/最早|最早一班/.test(text)) task.preference = "earliest";
  else if (/直飞|不要中转/.test(text)) task.preference = "direct";
  let cabin = null;
  if (/公务舱|商务舱|business/i.test(text)) cabin = "business";
  else if (/超级经济舱|高端经济舱|premium\s*economy/i.test(text)) cabin = "premium_economy";
  else if (/头等舱|first\s*class/i.test(text)) cabin = "first";
  else if (/经济舱|economy/i.test(text)) cabin = "economy";
  if (cabin) { searchChanged ||= task.cabin !== cabin; task.cabin = cabin; }
  const ord = { "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10 };
  const pick = text.match(/(?:选|要|订)(?:第)?([一二三四五六七八九十]|\d{1,2})(?:个|班|趟)?/);
  if (pick) task.choiceIndex = Number(pick[1]) || ord[pick[1]] || null;
  else if (searchChanged) delete task.choiceIndex;
  task.fromCode = CITY_CODES[task.from] || null;
  task.toCode = CITY_CODES[task.to] || null;
  task.missing = [!task.from && "出发城市", !task.to && "到达城市", !task.departDate && "出发日期"].filter(Boolean);
  return task;
}

export { CITY_CODES };
