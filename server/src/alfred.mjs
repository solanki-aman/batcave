// Client for the optional local decision model (Julia-1 sidecar, see alfred/).
// Every call has a hard timeout and returns null on any failure, so the server
// falls back to plain rules and never waits on the model.

export class Alfred {
  constructor(stats, url = process.env.BATCAVE_ALFRED_URL || 'http://127.0.0.1:4778', timeoutMs = Number(process.env.BATCAVE_ALFRED_TIMEOUT_MS || 900)) {
    this.stats = stats;
    this.url = url.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.disabled = process.env.BATCAVE_ALFRED === 'off';
    this.health = { ok: false, checkedAt: 0 };
    if (!this.disabled) { this.check(); setInterval(() => this.check(), 30000).unref(); }
  }

  get ready() { return !this.disabled && this.health.ok; }

  async check() {
    try {
      const r = await fetch(this.url + '/health', { signal: AbortSignal.timeout(1500) });
      const j = await r.json();
      this.health = { ok: Boolean(j.ok && j.loaded), model: j.model, device: j.device, loadMs: j.load_ms, checkedAt: Date.now() };
    } catch {
      this.health = { ok: false, checkedAt: Date.now() };
    }
  }

  // questions: { name: { type: 'choice', instructions, criteria: {key: desc} } | { type: 'noul', instructions } }
  async decide(state, questions, label = 'decide') {
    if (!this.ready) return null;
    const t0 = performance.now();
    try {
      const r = await fetch(this.url + '/decide', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state: String(state).slice(0, 4000), questions }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!r.ok) throw new Error(`alfred ${r.status}`);
      const j = await r.json();
      this.stats.time(`alfred:${label}`, performance.now() - t0);
      this.stats.count(`alfred_${label}`);
      return j.answers || null;
    } catch {
      this.stats.time(`alfred:${label}:failed`, performance.now() - t0);
      this.stats.count('alfred_failures');
      return null;
    }
  }
}

// Read a "noul" (yes probability) or "choice" answer defensively: field shapes vary by runtime.
export function yesProb(a) {
  if (!a) return null;
  const v = a.noul ?? a.probability ?? a.p ?? a.score;
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object') return Number(v.yes ?? v.true ?? v.p ?? NaN);
  return null;
}

export function topChoice(a) {
  if (!a) return null;
  let probs = a.probabilities || {};
  if (Array.isArray(probs)) probs = Object.fromEntries(probs.map((x, i) => (Array.isArray(x) ? x : [x.label ?? x.key ?? i, x.p ?? x.probability ?? x])));
  const choice = a.choice ?? Object.entries(probs).sort((x, y) => y[1] - x[1])[0]?.[0];
  return choice ? { choice, p: Number(probs[choice] ?? a.confidence ?? NaN) } : null;
}
