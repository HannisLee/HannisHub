import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";
const moduleResult = { exports: {} };
const source = fs.readFileSync(new URL("../lib/file-manager-browser.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
new Function("exports", "module", compiled)(moduleResult.exports, moduleResult);
const { readBrowserLocation, collectUploadEntry, collectDataTransferFiles } = moduleResult.exports;

function fileEntry(name) {
  return { name, isFile: true, isDirectory: false, file: resolve => resolve({ name, size: 10 }) };
}

function directoryEntry(name, batches) {
  let readers = 0;
  return {
    name, isFile: false, isDirectory: true,
    createReader() {
      readers += 1;
      assert.equal(readers, 1, "每个目录只创建一次读取器，避免重复读取第一批");
      let index = 0;
      return { readEntries: resolve => resolve(batches[index++] || []) };
    },
  };
}

test("目录跨批次读取完整，并保留嵌套路径和零字节文件", async () => {
  const firstBatch = Array.from({ length: 100 }, (_, i) => fileEntry(`${i}.md`));
  const emptyFile = fileEntry("empty.txt");
  emptyFile.file = resolve => resolve({ name: "empty.txt", size: 0 });
  const entry = directoryEntry("项目", [firstBatch, [directoryEntry("图片", [[fileEntry("a.png"), emptyFile]])], []]);
  const files = await collectUploadEntry(entry);
  assert.equal(files.length, 102);
  assert.equal(new Set(files.map(item => item.relativePath)).size, 102);
  assert.equal(files.at(-2).relativePath, "项目/图片/a.png");
  assert.equal(files.at(-1).file.size, 0);
});

test("跳过缓存目录，并把读取失败传播给上传反馈", async () => {
  const entry = directoryEntry("项目", [[{ name: "node_modules", isDirectory: true, createReader() { throw Error("不应读取"); } }, fileEntry("ok.md")]]);
  assert.equal((await collectUploadEntry(entry)).length, 1);
  const failing = fileEntry("bad.md");
  failing.file = (_, reject) => reject({ message: "permission denied" });
  await assert.rejects(collectUploadEntry(failing), /bad.md.*permission denied/);
});

test("拖拽数据在首次异步读取前捕获，不支持条目 API 时回退到文件列表", async () => {
  let readable = true;
  const file = fileEntry("ok.md");
  file.file = resolve => { readable = false; setTimeout(() => resolve({ name: "ok.md" }), 0); };
  const transfer = {
    get items() { assert.ok(readable); return [{ webkitGetAsEntry: () => file }]; },
    get files() { assert.ok(readable); return []; },
  };
  assert.equal((await collectDataTransferFiles(transfer))[0].relativePath, "ok.md");
  const fallback = await collectDataTransferFiles({ items: [], files: [{ name: "photo.png", webkitRelativePath: "folder/photo.png" }] });
  assert.equal(fallback[0].relativePath, "folder/photo.png");
});

test("目录记录按根目录路径恢复，根目录重排不会恢复到另一位置", () => {
  const storage = { getItem: () => JSON.stringify({ root: "/data", path: "project/docs" }) };
  assert.deepEqual(readBrowserLocation(storage, ["/other", "/data"]), { rootIndex: 1, path: "project/docs" });
  assert.equal(readBrowserLocation(storage, ["/other"]), null);
});

test("损坏、越界或不可用的存储不阻断文件浏览", () => {
  for (const raw of ["broken", "null", JSON.stringify({ root: "/data", path: "../secret" }), JSON.stringify({ root: "/data", path: "a//b" })]) {
    assert.equal(readBrowserLocation({ getItem: () => raw }, ["/data"]), null);
  }
  assert.equal(readBrowserLocation({ getItem() { throw Error("blocked"); } }, ["/data"]), null);
});
