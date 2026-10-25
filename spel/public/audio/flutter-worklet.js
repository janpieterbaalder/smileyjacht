// Butterfly wing flutter: a very soft, low breath of moving air on every downstroke (band-passed noise shaped by the
// stroke) with a barely audible rustle of the wing edges, at the wingbeat rate (~6-11 Hz). Kept subtle on purpose: a
// real butterfly is nearly silent; this is a hint close by, not a buzz. Plausible design values; the result must be
// judged by listening on the target phone, not from this code.
class Flutter extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rate', defaultValue: 8, minValue: 1, maxValue: 30, automationRate: 'k-rate' },
      { name: 'amp', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'effort', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }
  constructor(opts) {
    super();
    const seed = (opts && opts.processorOptions && opts.processorOptions.seed) || 1;
    this.rng = seed * 2654435761 % 4294967296;
    this.phase = this.rand(); this.env = 0;
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0; this.hp = 0; this.hpPrev = 0;
    this.jit = 0; this.beatAmp = 1;
  }
  rand() { this.rng = (this.rng * 1664525 + 1013904223) % 4294967296; return this.rng / 4294967296; }
  process(_in, outputs, params) {
    const out = outputs[0][0];
    if (!out) return true;
    const rate = params.rate[0], target = params.amp[0], effort = params.effort[0];
    const sr = sampleRate;
    // band-pass (RBJ biquad, constant peak gain) round 140-260 Hz for the air push, a little higher with effort; broad
    // (low Q) so it reads as a soft breath, not a tone
    const f = 140 + 120 * effort, w = 2 * Math.PI * f / sr, q = 0.7, al = Math.sin(w) / (2 * q), cw = Math.cos(w), a0 = 1 + al;
    const b0 = al / a0, b2 = -al / a0, a1 = -2 * cw / a0, a2 = (1 - al) / a0;
    for (let i = 0; i < out.length; i++) {
      this.env += (target - this.env) * 0.0015;
      this.phase += rate * (1 + this.jit * 0.08) / sr;
      if (this.phase >= 1) { this.phase -= 1; this.jit = this.rand() - 0.5; this.beatAmp = 0.85 + 0.3 * this.rand(); }
      const p = this.phase;
      // downstroke = first half of the beat: a smooth swell; the upstroke almost silent
      const stroke = p < 0.5 ? Math.sin(Math.PI * p * 2) ** 2 : 0.05 * Math.sin(Math.PI * (p - 0.5) * 2) ** 2;
      const n = this.rand() * 2 - 1;
      const y = b0 * n + b2 * this.x2 - a1 * this.y1 - a2 * this.y2;
      this.x2 = this.x1; this.x1 = n; this.y2 = this.y1; this.y1 = y;
      // faint rustle of the wing edges (high-passed noise)
      this.hp = 0.92 * (this.hp + n - this.hpPrev); this.hpPrev = n;
      out[i] = (y * 1.6 + this.hp * 0.01 * (0.4 + effort)) * stroke * this.beatAmp * this.env * 0.12;
    }
    return true;
  }
}
registerProcessor('smiley-flutter', Flutter);
