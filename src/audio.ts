// SPDX-License-Identifier: GPL-3.0-or-later
export class MetroAudio {
  private context: AudioContext | null = null;
  muted = true;
  async toggle(): Promise<boolean> {
    this.muted = !this.muted;
    if (!this.muted) {
      this.context ??= new AudioContext();
      await this.context.resume();
      this.note(523, 0.1);
    }
    return this.muted;
  }
  note(frequency: number, duration = 0.07): void {
    if (this.muted || !this.context) return;
    const ctx = this.context,
      osc = ctx.createOscillator(),
      gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.035, ctx.currentTime + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration);
  }
}
