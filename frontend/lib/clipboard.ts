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

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/gif": "gif",
};

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * 取出粘贴事件中的文件（截图、从网页或资源管理器复制的图片 / 文件）。
 * 截图等剪贴板图片通常没有有意义的文件名（Chrome 统一叫 image.png），改为「粘贴图片-时间.扩展名」；
 * 浏览器只在 items 中提供图片时也能取到。没有文件时返回空数组，调用方应让文字粘贴照常进行。
 */
export function clipboardFiles(data: DataTransfer | null, now: Date = new Date()): File[] {
  if (!data) return [];
  let files = Array.from(data.files || []);
  if (files.length === 0) {
    files = Array.from(data.items || [])
      .filter(item => item.kind === "file")
      .map(item => item.getAsFile())
      .filter((file): file is File => Boolean(file));
  }
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return files.map((file, index) => {
    const extension = IMAGE_EXTENSIONS[file.type];
    const generic = !file.name || /^image\.(png|jpe?g|webp|bmp|gif)$/i.test(file.name);
    if (!extension || !generic) return file;
    const suffix = files.length > 1 ? `-${index + 1}` : "";
    return new File([file], `粘贴图片-${stamp}${suffix}.${extension}`, { type: file.type, lastModified: now.getTime() });
  });
}
