import type { Terminal } from "@xterm/xterm";

/** 接管选择模式的鼠标操作，选区和复制内容仍由 xterm 管理。 */
export function bindTerminalSelection(host: HTMLElement, screen: HTMLElement, term: Terminal) {
  const mac = ["Macintosh", "MacIntel", "MacPPC", "Mac68K"].includes(navigator.platform);
  let forwarding = false;
  let dragging = false;
  let wheelRemainder = 0;

  const cancel = () => {
    if (!dragging) return;
    dragging = false;
    term.clearSelection();
  };

  function forward(target: EventTarget, type: string, event: MouseEvent, overrides: MouseEventInit = {}) {
    forwarding = true;
    try {
      target.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        detail: event.detail,
        clientX: event.clientX,
        clientY: event.clientY,
        button: event.button,
        buttons: event.buttons,
        ...overrides,
      }));
    } finally {
      forwarding = false;
    }
  }

  const mouseDown = (event: MouseEvent) => {
    if (forwarding || event.button !== 0 || !(event.target instanceof Node) || !screen.contains(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    dragging = true;
    const tracked = term.modes.mouseTrackingMode !== "none";
    // 与 xterm 的强制选择键一致，去掉实际按下的修饰键，避免进入列选或增量选择。
    forward(event.target, "mousedown", event, { shiftKey: tracked && !mac, altKey: tracked && mac });
  };

  const extend = (event: MouseEvent) => {
    const rect = screen.getBoundingClientRect();
    const edge = rect.height / term.rows / 2;
    const { clientY } = event;
    // 将可见区内的半行边缘纳入 xterm 的原生拖动滚动区域。
    const y = clientY >= rect.top && clientY < rect.top + edge ? Math.floor(rect.top) - 1
      : clientY <= rect.bottom && clientY > rect.bottom - edge ? Math.ceil(rect.bottom) + 1
      : clientY;
    if (event.type === "mousemove" && y === clientY) return;
    event.stopPropagation();
    forward(document, "mousemove", event, { clientY: y, buttons: 1 });
  };

  const mouseMove = (event: MouseEvent) => {
    if (forwarding || !dragging) return;
    if (event.buttons & 1) extend(event);
    else cancel();
  };

  const mouseUp = (event: MouseEvent) => {
    if (forwarding || !dragging || event.button !== 0) return;
    dragging = false;
    if (event.altKey) {
      // xterm 在 Alt+松手时可能向终端发送移动光标的按键。
      event.stopPropagation();
      forward(document, "mouseup", event);
    }
  };

  const hover = (event: MouseEvent) => {
    // 全鼠标跟踪会把无按键的移动视为终端输入，从而清除已完成的选区。
    if (!event.buttons && term.modes.mouseTrackingMode !== "none") event.stopPropagation();
  };

  const wheel = (event: WheelEvent) => {
    if (!(event.target instanceof Node) || !term.element?.contains(event.target)) return;
    event.stopPropagation();
    if (event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    const buffer = term.buffer.active;
    if (buffer.baseY === 0 || event.deltaY === 0) return;
    const rowHeight = screen.getBoundingClientRect().height / term.rows;
    if (!rowHeight) return;
    // 保留触控板的不足一行的增量，并兼容按行或按页上报的滚轮。
    const delta = event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? event.deltaY * term.rows
      : event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY
      : event.deltaY / rowHeight;
    if (wheelRemainder * delta < 0) wheelRemainder = 0;
    wheelRemainder += delta;
    const lines = Math.trunc(wheelRemainder);
    wheelRemainder -= lines;
    const before = buffer.viewportY;
    term.scrollLines(lines);
    if (dragging && buffer.viewportY !== before) extend(event);
  };

  const visibility = () => { if (document.hidden) cancel(); };
  const bufferChange = term.buffer.onBufferChange(cancel);
  const resize = term.onResize(cancel);
  host.addEventListener("mousedown", mouseDown, true);
  host.addEventListener("mousemove", hover, true);
  host.addEventListener("wheel", wheel, { capture: true, passive: false });
  document.addEventListener("mousemove", mouseMove, true);
  document.addEventListener("mouseup", mouseUp, true);
  document.addEventListener("pointercancel", cancel);
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("blur", cancel);
  return {
    cancel,
    dispose() {
      cancel();
      bufferChange.dispose();
      resize.dispose();
      host.removeEventListener("mousedown", mouseDown, true);
      host.removeEventListener("mousemove", hover, true);
      host.removeEventListener("wheel", wheel, true);
      document.removeEventListener("mousemove", mouseMove, true);
      document.removeEventListener("mouseup", mouseUp, true);
      document.removeEventListener("pointercancel", cancel);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("blur", cancel);
    },
  };
}
