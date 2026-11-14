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

const { clipboardShortcut } = load("../lib/terminal-clipboard.ts");
const { clipboardFiles } = load("../lib/clipboard.ts");

function key(key, modifiers = {}) {
  const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
  return { type: "keydown", key, code, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, isComposing: false, ...modifiers };
}

test("终端粘贴快捷键交给浏览器原生粘贴", () => {
  assert.equal(clipboardShortcut(key("v", { ctrlKey: true }), false), "paste");
  assert.equal(clipboardShortcut(key("V", { ctrlKey: true, shiftKey: true }), false), "paste");
  assert.equal(clipboardShortcut(key("Insert", { shiftKey: true }), false), "paste");
  assert.equal(clipboardShortcut(key("v", { metaKey: true }), false), "paste");
  // 非拉丁键盘布局：key 不是 v，但物理键位是 KeyV
  assert.equal(clipboardShortcut({ ...key("м", { ctrlKey: true }), code: "KeyV" }, false), "paste");
});

test("Ctrl+C 只在有选中文字时复制，否则仍是中断信号", () => {
  assert.equal(clipboardShortcut(key("c", { ctrlKey: true }), false), null);
  assert.equal(clipboardShortcut(key("c", { ctrlKey: true }), true), "copy");
  assert.equal(clipboardShortcut(key("Insert", { ctrlKey: true }), true), "copy");
  assert.equal(clipboardShortcut(key("Insert", { ctrlKey: true }), false), null);
  assert.equal(clipboardShortcut(key("C", { ctrlKey: true, shiftKey: true }), false), "copy-command");
});

test("其他按键、AltGr 组合、输入法组字与 keyup 不拦截", () => {
  assert.equal(clipboardShortcut(key("v"), false), null);
  assert.equal(clipboardShortcut(key("d", { ctrlKey: true }), false), null);
  assert.equal(clipboardShortcut(key("v", { ctrlKey: true, altKey: true }), false), null);
  assert.equal(clipboardShortcut(key("v", { ctrlKey: true, isComposing: true }), false), null);
  assert.equal(clipboardShortcut({ ...key("v", { ctrlKey: true }), type: "keyup" }, false), null);
});

test("剪贴板截图改名为「粘贴图片-时间」，原有文件名保留，纯文字返回空", () => {
  const now = new Date(2026, 10, 14, 9, 5, 7);
  const shot = new File(["png"], "image.png", { type: "image/png" });
  const named = new File(["pdf"], "合同.pdf", { type: "application/pdf" });
  assert.equal(clipboardFiles({ files: [shot], items: [] }, now)[0].name, "粘贴图片-20261114-090507.png");
  assert.equal(clipboardFiles({ files: [named], items: [] }, now)[0].name, "合同.pdf");
  const fromItems = clipboardFiles({ files: [], items: [{ kind: "file", getAsFile: () => new File(["j"], "", { type: "image/jpeg" }) }, { kind: "string", getAsFile: () => null }] }, now);
  assert.equal(fromItems[0].name, "粘贴图片-20261114-090507.jpg");
  assert.deepEqual(clipboardFiles({ files: [], items: [{ kind: "string", getAsFile: () => null }] }, now), []);
  assert.deepEqual(clipboardFiles(null, now), []);
});
