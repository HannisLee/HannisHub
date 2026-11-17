"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { emitPianoNote } from "../../../lib/lobby-piano";
import { SONGS } from "./songs";
import { PianoSound } from "./sound";
import styles from "./piano.module.css";

const SCALES = {
  major: { name: "大调", steps: [0, 2, 4, 5, 7, 9, 11] },
  minor: { name: "自然小调", steps: [0, 2, 3, 5, 7, 8, 10] },
  pentatonic: { name: "五声音阶", steps: [0, 2, 4, 7, 9] },
  chromatic: { name: "半音阶", steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
};
const NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
const ROWS = [["Z", "X", "C", "V", "B", "N", "M"], ["A", "S", "D", "F", "G", "H", "J", "K"]];
const KEYS = ROWS.flat();
const black = (midi: number) => [1, 3, 6, 8, 10].includes(midi % 12);
const noteName = (midi: number) => `${NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
const typing = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || !!target.closest("input, textarea, select"));

export function PianoPanel() {
  const [scale, setScale] = useState<keyof typeof SCALES>("major");
  const [root, setRoot] = useState(0);
  const [octave, setOctave] = useState(3);
  const [volume, setVolume] = useState(65);
  const [pedal, setPedal] = useState(false);
  const [active, setActive] = useState<Map<string, number>>(new Map());
  const [song, setSong] = useState<{ id: string; index: number; total: number } | null>(null);
  const playSong = useRef<(id: string | null) => void>(() => undefined);
  const [error, setError] = useState("");
  const sound = useRef<PianoSound | null>(null);
  const held = useRef(new Map<string, number>());
  const notes = useMemo(() => {
    const steps = SCALES[scale].steps;
    return KEYS.map((_, index) => (octave + 1) * 12 + root + Math.floor(index / steps.length) * 12 + steps[index % steps.length]);
  }, [scale, root, octave]);

  useEffect(() => {
    const audio = new PianoSound();
    sound.current = audio;
    return () => { audio.dispose(); sound.current = null; };
  }, []);

  useEffect(() => {
    let nextTimer: ReturnType<typeof setTimeout> | undefined;
    let releaseTimer: ReturnType<typeof setTimeout> | undefined;
    let automatic = false;
    const clear = () => {
      clearTimeout(nextTimer);
      clearTimeout(releaseTimer);
      automatic = false;
      setSong(null);
      sound.current?.silence();
      held.current.clear();
      setActive(new Map());
      setPedal(false);
    };
    const start = (id: string, midi: number) => {
      if (held.current.has(id)) return;
      try {
        sound.current?.play(id, midi);
        emitPianoNote();
        held.current.set(id, midi);
        setActive(new Map(held.current));
        setError("");
      } catch { setError("声音暂时无法启用，请检查浏览器的音频权限后再按琴键。"); }
    };
    const stop = (id: string) => {
      sound.current?.stop(id);
      held.current.delete(id);
      setActive(new Map(held.current));
    };
    playSong.current = id => {
      clear();
      const selected = SONGS.find(item => item.id === id);
      if (!selected) return;
      automatic = true;
      const base = notes[0];
      const step = (index: number) => {
        if (index >= selected.notes.length) { automatic = false; setSong(null); return; }
        const [offset, beats] = selected.notes[index];
        const duration = beats * selected.beat;
        start("song", base + offset);
        setSong({ id: selected.id, index: index + 1, total: selected.notes.length });
        releaseTimer = setTimeout(() => stop("song"), duration * 0.82);
        nextTimer = setTimeout(() => step(index + 1), duration);
      };
      step(0);
    };
    const down = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing || typing(event.target)) return;
      if (event.code === "Space") {
        event.preventDefault();
        sound.current?.pedal(true);
        setPedal(true);
      }
      const index = KEYS.findIndex(key => event.code === `Key${key}`);
      if (index < 0) return;
      event.preventDefault();
      if (!event.repeat) {
        if (automatic) clear();
        start(event.code, notes[index]);
      }
    };
    const up = (event: KeyboardEvent) => {
      if (event.code === "Space") { sound.current?.pedal(false); setPedal(false); }
      stop(event.code);
    };
    const hidden = () => { if (document.hidden) clear(); };
    const pointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-piano-note]") : null;
      if (!target) return;
      event.preventDefault();
      target.setPointerCapture(event.pointerId);
      if (automatic) clear();
      start(`pointer-${event.pointerId}`, Number(target.dataset.pianoNote));
    };
    const pointerUp = (event: PointerEvent) => stop(`pointer-${event.pointerId}`);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", clear);
    window.addEventListener("pointerdown", pointerDown);
    window.addEventListener("pointerup", pointerUp);
    window.addEventListener("pointercancel", pointerUp);
    window.addEventListener("lostpointercapture", pointerUp);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      clear();
      playSong.current = () => undefined;
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", clear);
      window.removeEventListener("pointerdown", pointerDown);
      window.removeEventListener("pointerup", pointerUp);
      window.removeEventListener("pointercancel", pointerUp);
      window.removeEventListener("lostpointercapture", pointerUp);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [notes]);

  const first = Math.floor(notes[0] / 12) * 12;
  const last = Math.ceil(notes.at(-1)! / 12) * 12;
  const range = Array.from({ length: last - first + 1 }, (_, i) => first + i);
  const whites = range.filter(midi => !black(midi));
  const playing = new Set(active.values());
  const keyFor = (midi: number) => KEYS[notes.indexOf(midi)];
  const renderKey = (midi: number, dark: boolean) => <button
    key={midi} type="button" data-piano-note={midi} aria-label={`琴键 ${noteName(midi)}${keyFor(midi) ? `，键盘 ${keyFor(midi)}` : ""}`}
    aria-pressed={playing.has(midi)}
    className={`${styles.key} ${dark ? styles.black : styles.white} ${notes.includes(midi) ? styles.inScale : ""}`}
    style={dark ? { left: `${(whites.filter(n => n < midi).length / whites.length) * 100}%`, width: `${60 / whites.length}%` } : undefined}
    onClick={event => {
      // 辅助技术与回车触发的点击没有指针事件，单独播放短音。
      if (event.detail === 0) {
        try {
          const id = `accessible-${midi}-${performance.now()}`;
          const audio = sound.current;
          playSong.current(null);
          audio?.play(id, midi);
          emitPianoNote();
          window.setTimeout(() => audio?.stop(id), 250);
        }
        catch { setError("声音暂时无法启用，请检查浏览器的音频权限。"); }
      }
    }}
  ><span>{noteName(midi)}</span><kbd>{keyFor(midi) || "·"}</kbd></button>;

  return <div className={styles.panel}>
    <header className={styles.intro}><div><p className={styles.eyebrow}>大厅 · 音乐角</p><h2>留一段旋律</h2><p>从一个音开始。双手放在键盘上，也可以直接轻触琴键。</p></div><span className={styles.range}>{noteName(notes[0])} — {noteName(notes.at(-1)!)}</span></header>
    <div className={styles.controls}>
      <label>音阶<select aria-label="音阶" value={scale} onChange={e => setScale(e.target.value as keyof typeof SCALES)}>{Object.entries(SCALES).map(([id, item]) => <option key={id} value={id}>{item.name}</option>)}</select></label>
      <label>主音<select aria-label="主音" value={root} onChange={e => setRoot(Number(e.target.value))}>{NAMES.map((name, i) => <option key={name} value={i}>{name}</option>)}</select></label>
      <label>起始八度<select aria-label="起始八度" value={octave} onChange={e => setOctave(Number(e.target.value))}>{[2, 3, 4].map(n => <option key={n} value={n}>{n} 组</option>)}</select></label>
      <label>音量 {volume}%<input aria-label="音量" type="range" min="0" max="100" value={volume} onChange={e => { const n = Number(e.target.value); setVolume(n); sound.current?.setVolume(n / 100); }} /></label>
      <button className={styles.pedal} type="button" aria-pressed={pedal} onClick={() => { sound.current?.pedal(!pedal); setPedal(!pedal); }}>延音 {pedal ? "开" : "关"}<kbd>Space</kbd></button>
    </div>
    <div className={styles.songs} aria-label="示范曲">
      <span>听一首</span>
      {SONGS.map(item => <button type="button" key={item.id} aria-pressed={song?.id === item.id} onClick={() => playSong.current(item.id)}>{song?.id === item.id ? "正在演奏 · " : "▷ "}{item.name}</button>)}
      <button type="button" disabled={!song} onClick={() => playSong.current(null)}>停止演奏</button>
      <span role="status">{song ? `${song.index} / ${song.total} 音` : "点击自动演奏，琴键同步亮起"}</span>
    </div>
    <p className={styles.tip}>示范曲按当前主音与八度演奏大调旋律；弹下琴键即可接手。</p>
    <div className={styles.readout} aria-label="正在演奏"><span>{playing.size ? [...playing].sort((a, b) => a - b).map(noteName).join(" · ") : "准备好，就按下第一个音"}</span><span>{pedal ? "延音踏板已踩下" : "支持多键和弦"}</span></div>
    <div className={styles.scroll}><div className={styles.keyboard} style={{ minWidth: Math.max(600, whites.length * 44) }}>{whites.map(midi => renderKey(midi, false))}{range.filter(black).map(midi => renderKey(midi, true))}</div></div>
    <div className={styles.mapping}>{[1, 0].map(row => <div key={row}><span>{row ? "高音" : "低音"}</span>{ROWS[row].map(key => { const midi = notes[KEYS.indexOf(key)]; return <div key={key} data-playing={playing.has(midi)}><kbd>{key}</kbd><small>{noteName(midi)}</small></div>; })}</div>)}</div>
    <p className={styles.tip}>字母键按所选音阶从低到高排列；琴面标出对应按键，所有黑白键均可点奏。按住空格延音，Esc 返回大厅。窄屏可横向滑动琴面。</p>
    {error && <p role="alert">{error}</p>}
  </div>;
}
