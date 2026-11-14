/** 网页终端的剪贴板快捷键判断：纯函数，便于单元测试。 */

/** 剪贴板快捷键的处理方式：paste/copy 交给浏览器原生事件，copy-command 需主动触发复制 */
export type ClipboardShortcut = "paste" | "copy" | "copy-command" | null;

/**
 * 判断一次按键是否为终端剪贴板快捷键（Windows / Linux 习惯，与 Windows Terminal 一致）。
 *
 * xterm.js 在非 macOS 平台会把 Ctrl+V 当作控制字符 ^V 发给 shell 并 preventDefault，
 * 浏览器因此不会触发 paste 事件——这就是 Windows 浏览器无法粘贴的原因。这里把粘贴、复制快捷键
 * 让回给浏览器，由原生 paste / copy 事件完成：它们不依赖 navigator.clipboard，HTTP 局域网访问同样可用。
 * - Ctrl+V、Ctrl+Shift+V、Shift+Insert：粘贴
 * - Ctrl+C（有选中文字时）、Ctrl+Insert：复制；没有选中时 Ctrl+C 仍发送中断信号
 * - Ctrl+Shift+C：复制（浏览器默认会打开开发者工具，始终阻止默认行为后主动触发复制）
 */
export function clipboardShortcut(event: Pick<KeyboardEvent, "type" | "key" | "code" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "isComposing">, hasSelection: boolean): ClipboardShortcut {
  if (event.type !== "keydown" || event.isComposing || event.altKey) return null;
  const key = event.key.toLowerCase();
  const mod = event.ctrlKey || event.metaKey;
  const isKey = (letter: string) => key === letter || event.code === `Key${letter.toUpperCase()}`;
  if (mod && isKey("v")) return "paste";
  if (event.shiftKey && !mod && key === "insert") return "paste";
  if (mod && !event.shiftKey && key === "insert") return hasSelection ? "copy" : null;
  if (mod && isKey("c")) {
    if (event.shiftKey) return "copy-command";
    return hasSelection ? "copy" : null;
  }
  return null;
}
