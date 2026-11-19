import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";

function load(path) {
  const loaded = { exports: {} };
  const source = fs.readFileSync(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function("exports", "module", compiled)(loaded.exports, loaded);
  return loaded.exports;
}

const { buildProgressTimeline, formatDurationShort, sortProgressEntries, sortTodoItems } = load("../lib/todo-timeline.ts");

function tsLocal(y, m, d, hh, mm, ss = 0) {
  return Math.floor(new Date(y, m - 1, d, hh, mm, ss).getTime() / 1000);
}

test("进度时间轴按规则展示首条完整日期、同日增量+时刻、跨日锚点", () => {
  const entries = [
    { id: "p4", text: "完成修复", created_at: tsLocal(2026, 11, 19, 18, 55) },
    { id: "p1", text: "开始训练", created_at: tsLocal(2026, 11, 19, 15, 0) },
    { id: "p6", text: "完成第二轮", created_at: tsLocal(2026, 11, 20, 9, 45) },
    { id: "p2", text: "完成第一次测试", created_at: tsLocal(2026, 11, 19, 17, 0) },
    { id: "p5", text: "开始第二轮", created_at: tsLocal(2026, 11, 20, 9, 0) },
    { id: "p3", text: "发现问题", created_at: tsLocal(2026, 11, 19, 17, 35) },
  ];

  const timeline = buildProgressTimeline(entries);
  assert.deepEqual(
    timeline.map(item => ({
      id: item.id,
      kind: item.kind,
      dateText: item.dateText,
      deltaText: item.deltaText,
      timeText: item.timeText,
      text: item.text,
    })),
    [
      { id: "p1", kind: "anchor", dateText: "2026-11-19", deltaText: "", timeText: "15:00", text: "开始训练" },
      { id: "p2", kind: "same-day", dateText: "", deltaText: "+2h", timeText: "17:00", text: "完成第一次测试" },
      { id: "p3", kind: "same-day", dateText: "", deltaText: "+35m", timeText: "17:35", text: "发现问题" },
      { id: "p4", kind: "same-day", dateText: "", deltaText: "+1h20m", timeText: "18:55", text: "完成修复" },
      { id: "p5", kind: "anchor", dateText: "2026-11-20", deltaText: "", timeText: "09:00", text: "开始第二轮" },
      { id: "p6", kind: "same-day", dateText: "", deltaText: "+45m", timeText: "09:45", text: "完成第二轮" },
    ],
  );
});

test("时间差格式化与跨月跨年、同时间戳及异常时间戳兼容", () => {
  assert.equal(formatDurationShort(30), "+<1m");
  assert.equal(formatDurationShort(5 * 60), "+5m");
  assert.equal(formatDurationShort(60 * 60), "+1h");
  assert.equal(formatDurationShort(90 * 60), "+1h30m");
  assert.equal(formatDurationShort(185 * 60), "+3h5m");

  const crossYear = buildProgressTimeline([
    { id: "a", text: "跨年前", created_at: tsLocal(2026, 12, 31, 23, 50) },
    { id: "b", text: "跨年后", created_at: tsLocal(2027, 1, 1, 0, 10) },
  ]);
  assert.equal(crossYear[0].kind, "anchor");
  assert.equal(crossYear[0].dateTimeText, "2026-12-31 23:50");
  assert.equal(crossYear[1].kind, "anchor");
  assert.equal(crossYear[1].dateTimeText, "2027-01-01 00:10");
  assert.equal(crossYear[1].deltaText, "");

  // 相同时间戳保持原相对顺序
  const sameTime = tsLocal(2026, 11, 19, 10, 0);
  const tied = sortProgressEntries([
    { id: "first", text: "第一条", created_at: sameTime },
    { id: "second", text: "第二条", created_at: sameTime },
  ]);
  assert.deepEqual(tied.map(i => i.id), ["first", "second"]);
  assert.equal(buildProgressTimeline(tied)[1].deltaText, "+<1m");

  // 异常时间戳不输出 NaN / Invalid Date 且保留日志内容
  const bad = buildProgressTimeline([
    { id: "ok1", text: "正常记录", created_at: tsLocal(2026, 11, 19, 11, 0) },
    { id: "bad", text: "异常时间戳", created_at: Number.NaN },
  ]);
  assert.equal(bad.length, 2);
  assert.equal(bad[1].kind, "unknown");
  assert.equal(bad[1].dateTimeText, "时间未知");
  assert.equal(bad[1].text, "异常时间戳");
  assert.ok(!bad[1].dateTimeText.includes("NaN") && !bad[1].dateTimeText.includes("Invalid"));
});

test("任务排序支持手动、优先级（兼容旧 0 值）与最近更新", () => {
  const items = [
    { id: "low", priority: 1, due_date: "", sort: 1, created_at: 100, updated_at: 200 },
    { id: "legacy", priority: 0, due_date: "", sort: 2, created_at: 101, updated_at: 500 },
    { id: "high", priority: 3, due_date: "", sort: 3, created_at: 102, updated_at: 300 },
  ];
  assert.deepEqual(sortTodoItems(items, "manual").map(i => i.id), ["low", "legacy", "high"]);
  assert.deepEqual(sortTodoItems(items, "priority").map(i => i.id), ["high", "legacy", "low"]);
  assert.deepEqual(sortTodoItems(items, "updated").map(i => i.id), ["legacy", "high", "low"]);
});
