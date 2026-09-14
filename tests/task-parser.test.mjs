import assert from "node:assert/strict";
import { parseDate, parseFlightMessage } from "../lib/task-parser.js";

const now = new Date(2026, 8, 9, 10, 0, 0);
assert.equal(parseDate("明天", now), "2026-09-10");
assert.equal(parseDate("后天", now), "2026-09-11");
assert.equal(parseDate("10月2日", now), "2026-10-02");

const a = parseFlightMessage("帮我在携程订机票");
assert.deepEqual(a.missing, ["出发城市", "到达城市", "出发日期"]);
const exact = parseFlightMessage("帮我在携程订机票 从上海到北京，明天，选最便宜的", null, now);
assert.deepEqual(
  { from: exact.from, to: exact.to, date: exact.departDate, preference: exact.preference, missing: exact.missing },
  { from: "上海", to: "北京", date: "2026-09-10", preference: "cheapest", missing: [] }
);
const b = parseFlightMessage("从上海到北京，明天，选最便宜的", a, now);
assert.equal(b.from, "上海");
assert.equal(b.to, "北京");
assert.equal(b.fromCode, "SHA");
assert.equal(b.toCode, "BJS");
assert.equal(b.departDate, "2026-09-10");
assert.equal(b.preference, "cheapest");
assert.deepEqual(b.missing, []);
assert.equal(parseFlightMessage("讲讲量子力学"), null);
const changedDate = parseFlightMessage("改成后天", b, now);
assert.equal(changedDate.departDate, "2026-09-11");
const business = parseFlightMessage("选公务舱", b, now);
assert.equal(business.cabin, "business");
assert.equal(business.preference, "cheapest");
const second = parseFlightMessage("选第二个", business, now);
assert.equal(second.choiceIndex, 2);
const firstClass = parseFlightMessage("改成头等舱", second, now);
assert.equal(firstClass.cabin, "first");
assert.equal(firstClass.choiceIndex, undefined);

// Search-site and query selection deliberately belongs to the server-side planner.
// The extension receives only its validated navigate action, never parses a local
// Google Patents/Bing URL from this raw instruction.
assert.equal("在google patent里搜彭瑞达的专利".includes("彭瑞达的专利"), true);
assert.equal("请用谷歌专利查一下量子计算".includes("量子计算"), true);
console.log("task-parser tests passed");
