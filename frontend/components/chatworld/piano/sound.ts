/** 本地合成钢琴音色：基音与泛音分别衰减，松键释放；不下载音源，也不上传演奏。 */
export class PianoSound {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private voices = new Map<string, { gain: GainNode; oscillators: OscillatorNode[] }>();
  private sustained = new Set<string>();
  sustain = false;
  volume = 0.65;

  play(id: string, midi: number) {
    this.release(id);
    const ctx = this.context ??= new AudioContext();
    if (!this.master) {
      this.master = ctx.createGain();
      const compressor = ctx.createDynamicsCompressor();
      this.master.connect(compressor);
      compressor.connect(ctx.destination);
    }
    void ctx.resume().catch(() => undefined);
    this.master.gain.setTargetAtTime(this.volume, ctx.currentTime, 0.015);
    // 最多保留 48 个声部，长时间踩延音时也不会无限积累节点。
    if (this.voices.size >= 48) this.release(this.voices.keys().next().value!);
    const gain = ctx.createGain();
    gain.connect(this.master);
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.22, ctx.currentTime + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 5);
    const frequency = 440 * 2 ** ((midi - 69) / 12);
    const oscillators = [1, 2, 3, 4].map((harmonic, index) => {
      const osc = ctx.createOscillator();
      const partial = ctx.createGain();
      osc.frequency.value = frequency * harmonic;
      partial.gain.setValueAtTime([0.8, 0.2, 0.08, 0.035][index], ctx.currentTime);
      partial.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 5 / harmonic);
      osc.connect(partial);
      partial.connect(gain);
      osc.start();
      osc.stop(ctx.currentTime + 5.1);
      osc.onended = () => {
        osc.disconnect();
        partial.disconnect();
        if (this.voices.get(id)?.gain === gain) {
          this.voices.delete(id);
          this.sustained.delete(id);
        }
        if (index === 3) gain.disconnect();
      };
      return osc;
    });
    this.voices.set(id, { gain, oscillators });
  }

  stop(id: string) {
    if (this.sustain) this.sustained.add(id);
    else this.release(id);
  }

  private release(id: string) {
    const voice = this.voices.get(id);
    if (!voice || !this.context) return;
    const at = this.context.currentTime;
    voice.gain.gain.cancelAndHoldAtTime(at);
    voice.gain.gain.setTargetAtTime(0, at, 0.07);
    voice.oscillators.forEach(osc => osc.stop(at + 0.4));
    this.voices.delete(id);
    this.sustained.delete(id);
  }

  pedal(down: boolean) {
    this.sustain = down;
    if (!down) [...this.sustained].forEach(id => this.release(id));
  }

  setVolume(value: number) {
    this.volume = value;
    if (this.context && this.master) this.master.gain.setTargetAtTime(value, this.context.currentTime, 0.015);
  }

  silence() {
    this.pedal(false);
    [...this.voices.keys()].forEach(id => this.release(id));
  }

  dispose() {
    this.silence();
    void this.context?.close();
    this.context = null;
    this.master = null;
  }
}
