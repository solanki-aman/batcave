// Batcave stats: latency and savings, kept small enough to live in the JSON store.
// Latency keeps a rolling window per key; counters accumulate forever.

const WINDOW = 400;
export const estTokens = (text) => Math.ceil(String(text || '').length / 4);

export class Stats {
  constructor(store) {
    store.data.stats ||= {};
    const s = store.data.stats;
    s.startedAt ||= Date.now();
    s.latency ||= {};   // key -> { n, total, samples: [] }
    s.counters ||= {};  // name -> number
    s.tokens ||= { injected: 0, savedDedupe: 0, savedRanking: 0, handoffs: 0 };
    s.daily ||= {};     // YYYY-MM-DD -> { injected, saved }
    this.s = s;
  }

  time(key, ms) {
    const l = (this.s.latency[key] ||= { n: 0, total: 0, samples: [] });
    l.n += 1; l.total += ms;
    l.samples.push(Math.round(ms * 10) / 10);
    if (l.samples.length > WINDOW) l.samples.splice(0, l.samples.length - WINDOW);
  }

  count(name, by = 1) { this.s.counters[name] = (this.s.counters[name] || 0) + by; }

  tokens(kind, n) {
    if (!n) return;
    this.s.tokens[kind] = (this.s.tokens[kind] || 0) + n;
    const day = new Date().toISOString().slice(0, 10);
    const d = (this.s.daily[day] ||= { injected: 0, saved: 0 });
    if (kind === 'injected') d.injected += n; else d.saved += n;
    const days = Object.keys(this.s.daily).sort();
    for (const k of days.slice(0, Math.max(0, days.length - 30))) delete this.s.daily[k];
  }

  summary() {
    const pct = (arr, p) => { if (!arr.length) return null; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; };
    const latency = {};
    for (const [k, l] of Object.entries(this.s.latency)) {
      latency[k] = { count: l.n, avg: Math.round((l.total / Math.max(1, l.n)) * 10) / 10, p50: pct(l.samples, 0.5), p95: pct(l.samples, 0.95) };
    }
    const t = this.s.tokens;
    const saved = (t.savedDedupe || 0) + (t.savedRanking || 0) + (t.handoffs || 0);
    return {
      since: this.s.startedAt,
      latency,
      counters: this.s.counters,
      tokens: { ...t, saved, savedPct: t.injected + saved ? Math.round((saved / (t.injected + saved)) * 1000) / 10 : 0 },
      daily: this.s.daily,
    };
  }
}
