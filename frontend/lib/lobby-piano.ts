/** 演奏事件只驱动本机大厅动画；音符气泡沿用已有的表情广播。 */
const PIANO_NOTE = "hannishub:piano-note";
export function emitPianoNote() { window.dispatchEvent(new Event(PIANO_NOTE)); }
export function onPianoNote(listener: () => void) {
  window.addEventListener(PIANO_NOTE, listener);
  return () => window.removeEventListener(PIANO_NOTE, listener);
}
