import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(fs.readFileSync(new URL('../lib/chat-notify.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function windows() {
  const shared = new Map();
  const tabs = [];
  function tab() {
    const events = new Map();
    const documentEvents = new Map();
    const target = handlers => ({
      addEventListener: (name, listener) => {
        if (!handlers.has(name)) handlers.set(name, new Set());
        handlers.get(name).add(listener);
      },
      removeEventListener: (name, listener) => handlers.get(name)?.delete(listener),
    });
    const fire = (name, event) => events.get(name)?.forEach(listener => listener(event));
    const exports = {};
    vm.runInNewContext(source, { exports, window: {
      ...target(events),
      localStorage: {
        getItem: key => shared.get(key) ?? null,
        setItem: (key, value) => {
          shared.set(key, value);
          for (const other of tabs) if (other.fire !== fire) other.fire('storage', {key, newValue:value});
        },
      },
      setTimeout: () => 1, clearTimeout() {},
    }, document: target(documentEvents) });
    const result = { api: exports, fire };
    tabs.push(result);
    exports.subscribeChatNotify(() => {});
    return result;
  }
  return { tab };
}
const message = id => ({id, nickname:'测试', content:'消息'});

test('一个窗口读完后其他窗口清除未读和提示条', () => {
  const {tab} = windows();
  const a = tab().api, b = tab().api;
  b.addChatUnread([message(1), message(2)]);
  b.showChatToast(message(2));
  a.markChatRead(2);
  assert.equal(b.getChatNotifySnapshot().unread, 0);
  assert.equal(b.getChatNotifySnapshot().toast, null);
});

test('部分已读保留更新消息，旧响应不会重新累计未读', () => {
  const {tab} = windows();
  const a = tab().api, b = tab().api;
  b.addChatUnread([message(1), message(2), message(3)]);
  a.markChatRead(2);
  assert.equal(b.getChatNotifySnapshot().unread, 1);
  b.setChatUnread([message(1), message(2), message(3)]);
  b.addChatUnread([message(3)]);
  assert.equal(b.getChatNotifySnapshot().unread, 1);
  a.markChatRead(3);
  b.addChatUnread([message(1), message(2), message(3)]);
  b.showChatToast(message(3));
  assert.equal(b.getChatNotifySnapshot().unread, 0);
  assert.equal(b.getChatNotifySnapshot().toast, null);
});

test('同窗口读取也收起提示，已读位置只增不减', () => {
  const {tab} = windows();
  const a = tab().api;
  a.addChatUnread([message(4)]);
  a.showChatToast(message(4));
  a.markChatRead(4);
  assert.equal(a.getChatNotifySnapshot().toast, null);
  a.markChatRead(2);
  assert.equal(a.getLastRead(), 4);
  a.addChatUnread([message(5)]);
  assert.equal(a.getChatNotifySnapshot().unread, 1);
});
