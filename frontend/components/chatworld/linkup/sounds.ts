/** 连连看音效与背景音乐：全部用 Web Audio 实时合成（方波 / 三角波 / 噪声），不加载音频文件。
 *  8-bit 风格：脉冲波主旋律 + 三角波低音 + 噪声打击；时间快到时音乐自动切换为快节奏。
 *  音效与音乐可分别开关，设置保存在浏览器本地；首次用户操作后才创建 AudioContext（自动播放限制）。 */

export type Sfx =
  | "select" | "deselect" | "match" | "error" | "hint" | "shuffle" | "slide"
  | "ready" | "go" | "clear" | "over" | "tick" | "pause" | "resume" | "record" | "click" | "combo";

const SFX_KEY = "hannishub:linkup-sfx-muted";
const MUSIC_KEY = "hannishub:linkup-music-muted";
/** 背景音乐总音量（音效总线为 1） */
const MUSIC_VOLUME = 0.3;

function readFlag(key: string): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string, value: boolean) {
  try {
    window.localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // 浏览器存储不可用时只在本次生效
  }
}

/** 音名 → 频率，如 "C5"、"F#4" */
const NOTE_INDEX: Record<string, number> = { C: 0, "C#": 1, D: 2, "D#": 3, E: 4, F: 5, "F#": 6, G: 7, "G#": 8, A: 9, "A#": 10, B: 11 };
export function noteFreq(name: string): number {
  const match = /^([A-G]#?)(\d)$/.exec(name);
  if (!match) return 0;
  const semis = NOTE_INDEX[match[1]] + (Number(match[2]) + 1) * 12;
  return 440 * Math.pow(2, (semis - 69) / 12);
}

// ---------------------------------------------------------------- 背景音乐（原创 8 小节循环，八分音符为一步）

/** 主旋律：每小节 8 步，"-" 表示延续上一个音，"." 为休止 */
const MELODY = [
  "E5 G5 A5 G5 E5 D5 C5 D5",
  "E5 - G5 - D5 - - .",
  "C5 D5 E5 G5 A5 C6 A5 G5",
  "E5 - D5 - C5 - - .",
  "A4 C5 D5 E5 G5 E5 D5 C5",
  "D5 - E5 - G5 - - .",
  "A5 G5 E5 G5 A5 C6 D6 C6",
  "A5 - G5 - C6 - - .",
].join(" ").split(" ");

/** 和声根音：每小节一个，低音按「根音 - 高八度」交替弹奏 */
const BASS_ROOTS = ["C3", "G2", "A2", "E2", "F2", "G2", "F2", "G2"];
/** 每小节的和弦分解（第二声部，三角波轻声垫底） */
const CHORDS: string[][] = [
  ["C4", "E4", "G4"], ["B3", "D4", "G4"], ["A3", "C4", "E4"], ["G3", "C4", "E4"],
  ["A3", "C4", "F4"], ["B3", "D4", "G4"], ["A3", "C4", "F4"], ["B3", "D4", "G4"],
];

class LinkupAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private pulse: PeriodicWave | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private step = 0;
  private nextTime = 0;
  private tempo = 132;
  private wantMusic = false;
  sfxMuted = readFlag(SFX_KEY);
  musicMuted = readFlag(MUSIC_KEY);

  /** 在用户手势中调用：创建或恢复 AudioContext */
  unlock() {
    if (typeof window === "undefined") return;
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = 1;
      this.master.connect(ctx.destination);
      this.sfxBus = ctx.createGain();
      this.sfxBus.gain.value = 1;
      this.sfxBus.connect(this.master);
      this.musicBus = ctx.createGain();
      this.musicBus.gain.value = this.musicMuted ? 0 : MUSIC_VOLUME;
      this.musicBus.connect(this.master);
      // 白噪声样本（打击乐、洗牌声）
      const length = Math.floor(ctx.sampleRate * 0.6);
      this.noiseBuffer = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = this.noiseBuffer.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
      // 25% 占空比脉冲波：比方波更「红白机」
      const harmonics = 32;
      const real = new Float32Array(harmonics);
      const imag = new Float32Array(harmonics);
      for (let n = 1; n < harmonics; n++) imag[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * 0.25);
      this.pulse = ctx.createPeriodicWave(real, imag);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    if (this.wantMusic && !this.timer) this.startScheduler();
  }

  setSfxMuted(muted: boolean) {
    this.sfxMuted = muted;
    writeFlag(SFX_KEY, muted);
  }

  setMusicMuted(muted: boolean) {
    this.musicMuted = muted;
    writeFlag(MUSIC_KEY, muted);
    if (this.musicBus && this.ctx) this.musicBus.gain.setTargetAtTime(muted ? 0 : MUSIC_VOLUME, this.ctx.currentTime, 0.05);
  }

  // ---------------------------------------------------------------- 合成工具

  /** 单个音：type 为波形，slide 为结束时滑到的频率 */
  private tone(freq: number, start: number, duration: number, options: {
    type?: OscillatorType | "pulse"; volume?: number; slide?: number; attack?: number; bus?: GainNode | null; vibrato?: number;
  } = {}) {
    const ctx = this.ctx;
    const bus = options.bus ?? this.sfxBus;
    if (!ctx || !bus || freq <= 0) return;
    const osc = ctx.createOscillator();
    if (options.type === "pulse" && this.pulse) osc.setPeriodicWave(this.pulse);
    else osc.type = (options.type as OscillatorType) ?? "square";
    osc.frequency.setValueAtTime(freq, start);
    if (options.slide) osc.frequency.exponentialRampToValueAtTime(Math.max(20, options.slide), start + duration);
    if (options.vibrato) {
      const lfo = ctx.createOscillator();
      const depth = ctx.createGain();
      lfo.frequency.value = 18;
      depth.gain.value = options.vibrato;
      lfo.connect(depth).connect(osc.frequency);
      lfo.start(start);
      lfo.stop(start + duration + 0.02);
    }
    const gain = ctx.createGain();
    const volume = options.volume ?? 0.3;
    const attack = options.attack ?? 0.004;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(gain).connect(bus);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  /** 噪声：filter 为带通中心频率，sweep 为结束时的中心频率 */
  private noise(start: number, duration: number, options: { volume?: number; filter?: number; sweep?: number; q?: number; bus?: GainNode | null } = {}) {
    const ctx = this.ctx;
    const bus = options.bus ?? this.sfxBus;
    if (!ctx || !bus || !this.noiseBuffer) return;
    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.Q.value = options.q ?? 1.2;
    filter.frequency.setValueAtTime(options.filter ?? 3000, start);
    if (options.sweep) filter.frequency.exponentialRampToValueAtTime(options.sweep, start + duration);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(options.volume ?? 0.2, start);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    source.connect(filter).connect(gain).connect(bus);
    source.start(start, Math.random() * 0.2);
    source.stop(start + duration + 0.02);
  }

  /** 播放音效；level 用于连击音高（消除）或倒计时剩余秒数（滴答） */
  play(name: Sfx, level = 0) {
    const ctx = this.ctx;
    if (!ctx || this.sfxMuted) return;
    const t = ctx.currentTime + 0.005;
    switch (name) {
      case "click":
        this.tone(1800, t, 0.03, { type: "square", volume: 0.08 });
        break;
      case "select":
        this.tone(988, t, 0.05, { type: "pulse", volume: 0.22, slide: 1318 });
        break;
      case "deselect":
        this.tone(784, t, 0.05, { type: "pulse", volume: 0.16, slide: 587 });
        break;
      case "match": {
        // 电流「滋」声 + 随连击升调的清脆双音
        const lift = Math.pow(2, Math.min(level, 12) / 12);
        this.noise(t, 0.12, { volume: 0.18, filter: 5000, sweep: 1500, q: 0.8 });
        this.tone(1600, t, 0.1, { type: "sawtooth", volume: 0.08, slide: 420 });
        this.tone(1046 * lift, t + 0.06, 0.09, { type: "square", volume: 0.18 });
        this.tone(1568 * lift, t + 0.12, 0.16, { type: "square", volume: 0.16 });
        break;
      }
      case "combo": {
        // 连击：按连击数弹一段上行琶音
        const notes = ["C6", "E6", "G6", "C7", "E7"];
        const count = Math.min(notes.length, Math.max(2, level));
        for (let i = 0; i < count; i++) this.tone(noteFreq(notes[i]), t + 0.2 + i * 0.045, 0.08, { type: "pulse", volume: 0.24 });
        break;
      }
      case "error":
        this.tone(196, t, 0.18, { type: "square", volume: 0.16, vibrato: 14 });
        this.tone(185, t, 0.18, { type: "square", volume: 0.12 });
        break;
      case "hint":
        ["E6", "G#6", "B6", "E7"].forEach((n, i) => this.tone(noteFreq(n), t + i * 0.06, 0.12, { type: "triangle", volume: 0.22 }));
        break;
      case "shuffle":
        this.noise(t, 0.38, { volume: 0.6, filter: 400, sweep: 4200, q: 1.4 });
        for (let i = 0; i < 7; i++) this.tone(600 + Math.random() * 900, t + 0.04 + i * 0.045, 0.03, { type: "square", volume: 0.12 });
        break;
      case "slide":
        this.tone(330, t, 0.07, { type: "triangle", volume: 0.14, slide: 196 });
        break;
      case "ready":
        this.tone(noteFreq("C5"), t, 0.12, { type: "pulse", volume: 0.2 });
        break;
      case "go":
        this.tone(noteFreq("C6"), t, 0.3, { type: "pulse", volume: 0.22 });
        this.tone(noteFreq("G5"), t, 0.3, { type: "triangle", volume: 0.2 });
        break;
      case "clear": {
        // 过关小号
        const seq: [string, number][] = [["C5", 0], ["E5", 0.1], ["G5", 0.2], ["C6", 0.3], ["G5", 0.45], ["C6", 0.55]];
        seq.forEach(([n, d], i) => this.tone(noteFreq(n), t + d, i === seq.length - 1 ? 0.5 : 0.12, { type: "pulse", volume: 0.2 }));
        [["C3", 0], ["G3", 0.3], ["C4", 0.55]].forEach(([n, d]) => this.tone(noteFreq(n as string), t + (d as number), 0.25, { type: "triangle", volume: 0.3 }));
        break;
      }
      case "over": {
        const seq: [string, number, number][] = [["G4", 0, 0.2], ["E4", 0.22, 0.2], ["C4", 0.44, 0.2], ["B3", 0.66, 0.14], ["A#3", 0.82, 0.14], ["A3", 0.98, 0.6]];
        seq.forEach(([n, d, len]) => this.tone(noteFreq(n), t + d, len, { type: "pulse", volume: 0.18 }));
        this.tone(noteFreq("C3"), t, 1.4, { type: "triangle", volume: 0.25, slide: noteFreq("A2") });
        break;
      }
      case "tick":
        // 最后十秒：每秒一声，越接近零越高
        this.tone(level <= 3 ? 1760 : 1320, t, 0.04, { type: "square", volume: 0.12 });
        this.noise(t, 0.03, { volume: 0.08, filter: 6000 });
        break;
      case "pause":
        this.tone(880, t, 0.06, { type: "pulse", volume: 0.15, slide: 440 });
        break;
      case "resume":
        this.tone(440, t, 0.06, { type: "pulse", volume: 0.15, slide: 880 });
        break;
      case "record":
        ["G5", "C6", "E6", "G6", "E6", "G6", "C7"].forEach((n, i) => this.tone(noteFreq(n), t + i * 0.08, i === 6 ? 0.4 : 0.09, { type: "pulse", volume: 0.18 }));
        break;
    }
  }

  // ---------------------------------------------------------------- 背景音乐

  /** 开始 / 继续播放背景音乐；fast 为时间紧张时的快节奏 */
  startMusic(fast = false) {
    this.wantMusic = true;
    this.tempo = fast ? 168 : 132;
    if (this.ctx && !this.timer) this.startScheduler();
  }

  setFast(fast: boolean) {
    this.tempo = fast ? 168 : 132;
  }

  stopMusic() {
    this.wantMusic = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private startScheduler() {
    const ctx = this.ctx;
    if (!ctx) return;
    this.nextTime = ctx.currentTime + 0.08;
    this.step = 0;
    // 前瞻调度：每 25ms 检查一次，把未来 120ms 内的音符排好
    this.timer = setInterval(() => {
      if (!this.ctx) return;
      while (this.nextTime < this.ctx.currentTime + 0.12) {
        this.scheduleStep(this.step, this.nextTime);
        this.nextTime += 60 / this.tempo / 2;
        this.step = (this.step + 1) % MELODY.length;
      }
    }, 25);
  }

  private scheduleStep(step: number, time: number) {
    const bus = this.musicBus;
    if (!bus) return;
    const eighth = 60 / this.tempo / 2;
    const bar = Math.floor(step / 8);
    const beat = step % 8;
    // 主旋律：计算本音延续的步数
    const note = MELODY[step];
    if (note !== "-" && note !== ".") {
      let len = 1;
      while (MELODY[(step + len) % MELODY.length] === "-" && len < 8) len++;
      this.tone(noteFreq(note), time, eighth * len * 0.92, { type: "pulse", volume: 0.16, bus, attack: 0.006 });
    }
    // 低音：根音与高八度交替
    const root = noteFreq(BASS_ROOTS[bar]);
    this.tone(beat % 2 === 0 ? root : root * 2, time, eighth * 0.85, { type: "triangle", volume: 0.32, bus });
    // 和弦分解：反拍轻声
    if (beat % 2 === 1) {
      const chord = CHORDS[bar];
      this.tone(noteFreq(chord[(beat >> 1) % chord.length]), time, eighth * 0.6, { type: "square", volume: 0.035, bus });
    }
    // 打击：正拍底鼓（低频滑音），反拍踩镲（高频噪声）
    if (beat % 4 === 0) this.tone(150, time, 0.08, { type: "sine", volume: 0.35, slide: 50, bus });
    if (beat % 2 === 1) this.noise(time, 0.035, { volume: 0.06, filter: 9000, q: 0.7, bus });
    if (beat === 4) this.noise(time, 0.09, { volume: 0.1, filter: 2200, q: 0.6, bus });
  }

  close() {
    this.stopMusic();
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.master = null;
    this.sfxBus = null;
    this.musicBus = null;
  }
}

let shared: LinkupAudio | null = null;

export function linkupAudio(): LinkupAudio {
  if (!shared) shared = new LinkupAudio();
  return shared;
}
