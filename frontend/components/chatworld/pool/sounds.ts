/** 台球音效：Pool And Billiards SFX（SURAJ KISPOTTA，CC0），转为单声道 mp3 放在 public/chat-lobby/pool/。
 *  用 Web Audio 播放，同一种声音可以叠加；首次用户操作后才创建 AudioContext（浏览器自动播放限制）。 */

const BASE = "/chat-lobby/pool";

export type SoundKey = "hit" | "rail" | "pocket" | "cue" | "turn" | "start";

const FILES: Record<SoundKey, string[]> = {
  hit: ["hit1", "hit2", "hit3"],
  rail: ["rail1", "rail2"],
  pocket: ["pocket"],
  cue: ["cue1", "cue2"],
  turn: ["turn"],
  start: ["start"],
};

const MUTE_KEY = "hannishub:pool-muted";

class PoolSounds {
  private ctx: AudioContext | null = null;
  private buffers = new Map<string, AudioBuffer>();
  private loading: Promise<void> | null = null;
  muted = false;

  constructor() {
    try {
      this.muted = typeof window !== "undefined" && window.localStorage.getItem(MUTE_KEY) === "1";
    } catch {
      this.muted = false;
    }
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    try {
      window.localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
    } catch {
      // 浏览器存储不可用时只在本次生效
    }
  }

  /** 在用户手势（点击、按键）中调用：创建或恢复 AudioContext 并加载音效 */
  unlock() {
    if (typeof window === "undefined") return;
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    if (!this.loading) this.loading = this.load();
  }

  private async load() {
    const ctx = this.ctx;
    if (!ctx) return;
    const names = Object.values(FILES).flat();
    await Promise.all(names.map(async name => {
      try {
        const response = await fetch(`${BASE}/${name}.mp3`);
        const data = await response.arrayBuffer();
        this.buffers.set(name, await ctx.decodeAudioData(data));
      } catch {
        // 单个音效加载失败不影响游戏
      }
    }));
  }

  /** 播放音效；volume 0–1，delay 为相对现在的延迟秒数 */
  play(key: SoundKey, volume = 1, delay = 0) {
    const ctx = this.ctx;
    if (!ctx || this.muted || volume <= 0.01) return;
    const options = FILES[key];
    const buffer = this.buffers.get(options[Math.floor(Math.random() * options.length)]);
    if (!buffer) return;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = 0.94 + Math.random() * 0.12;
    const gain = ctx.createGain();
    gain.gain.value = Math.min(1, volume);
    source.connect(gain).connect(ctx.destination);
    source.start(ctx.currentTime + Math.max(0, delay));
  }

  close() {
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.buffers.clear();
    this.loading = null;
  }
}

let shared: PoolSounds | null = null;

export function poolSounds(): PoolSounds {
  if (!shared) shared = new PoolSounds();
  return shared;
}
