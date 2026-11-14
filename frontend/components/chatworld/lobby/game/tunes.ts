/** 大厅乐器的短旋律：用 Web Audio 现场合成（不需要音频素材），只在本机播放，音量较小。
 *  浏览器要求音频在用户操作后才能启动；调用方都在按键交互里触发，满足该要求。 */

type TuneKind = "piano" | "guitar";

/** C 大调五声音阶（C D E G A），随机组合也不会难听 */
const PENTATONIC = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.25];

let context: AudioContext | null = null;
let playingUntil = 0;

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!context) context = new Ctor();
  if (context.state === "suspended") void context.resume();
  return context;
}

/** 单个音：钢琴用三角波快速衰减，吉他用锯齿波过低通、衰减更快（拨弦感） */
function note(ctx: AudioContext, freq: number, at: number, kind: TuneKind) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  osc.type = kind === "piano" ? "triangle" : "sawtooth";
  osc.frequency.value = kind === "guitar" ? freq / 2 : freq;
  filter.type = "lowpass";
  filter.frequency.value = kind === "guitar" ? 1400 : 3200;
  const peak = kind === "piano" ? 0.09 : 0.06;
  const length = kind === "piano" ? 0.9 : 0.5;
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(peak, at + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
  osc.connect(filter).connect(gain).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + length + 0.05);
}

/** 播放一小段随机旋律；上一段还没播完时忽略，避免叠成噪音 */
export function playTune(kind: TuneKind) {
  const ctx = audio();
  if (!ctx) return;
  const now = ctx.currentTime;
  if (now < playingUntil) return;
  const step = kind === "piano" ? 0.26 : 0.16;
  const count = kind === "piano" ? 10 : 8;
  let index = Math.floor(Math.random() * 4);
  for (let i = 0; i < count; i++) {
    // 以级进为主，偶尔跳进，听起来像一句旋律
    index = Math.max(0, Math.min(PENTATONIC.length - 1, index + Math.floor(Math.random() * 5) - 2));
    const at = now + 0.03 + i * step;
    note(ctx, PENTATONIC[index], at, kind);
    // 钢琴每隔一拍加一个低八度的伴奏音
    if (kind === "piano" && i % 2 === 0) note(ctx, PENTATONIC[(index + 3) % 5] / 2, at, kind);
  }
  playingUntil = now + count * step;
}
