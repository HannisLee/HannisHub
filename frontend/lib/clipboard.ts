/** 剪贴板工具：提示词页与终端浮动提示词共用。 */

function legacyCopyText(value: string): boolean {
  // 非安全上下文（例如通过 HTTP IP 访问）可能没有异步 Clipboard API，使用同步复制兜底。
  const textarea = document.createElement("textarea");
  const previousActive = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  let copied = false;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  previousActive?.focus();
  textarea.remove();
  return copied;
}

/** 复制文本，返回是否成功。 */
export function copyToClipboard(value: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(value).then(() => true).catch(() => false);
  }
  return Promise.resolve(legacyCopyText(value));
}
