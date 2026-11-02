// Embeddings: Alfred's shortlister. With an embedding model loaded in the Alfred
// sidecar (EmbeddingGemma 2 by default), Batcave narrows long candidate lists
// (all decisions and room history, the whole backlog, every teammate) to the
// few closest by meaning, and Julia-1 decides among those. Julia-1 does worse
// as the list of options grows; embeddings make every list short.
//
// Vectors are cached by text, truncated to BATCAVE_EMBED_DIMS (256 by default,
// Matryoshka), and never leave the machine running the server.
import crypto from 'node:crypto';

const DIMS = Number(process.env.BATCAVE_EMBED_DIMS || 256);
const TIMEOUT = Number(process.env.BATCAVE_EMBED_TIMEOUT_MS || 1500);
const CACHE_MAX = 20000;

export class Embeddings {
  constructor(alfred, stats) {
    this.alfred = alfred;
    this.stats = stats;
    this.cache = new Map();   // kind|sha1(text) -> number[]
    this.disabled = process.env.BATCAVE_EMBED === 'off';
  }

  get ready() { return !this.disabled && this.alfred.ready && Boolean(this.alfred.health.embed); }

  key(kind, text) { return `${kind}|${crypto.createHash('sha1').update(text).digest('hex')}`; }

  async vectors(texts, kind) {
    const keys = texts.map((t) => this.key(kind, t));
    const missing = [...new Set(texts.filter((t, i) => !this.cache.has(keys[i])))];
    if (missing.length) {
      const t0 = performance.now();
      for (let i = 0; i < missing.length; i += 128) {
        const batch = missing.slice(i, i + 128);
        const r = await fetch(`${this.alfred.url}/embed`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ texts: batch, kind, dims: DIMS }), signal: AbortSignal.timeout(TIMEOUT),
        });
        if (!r.ok) throw new Error(`embed ${r.status}`);
        const { vectors } = await r.json();
        batch.forEach((t, j) => this.cache.set(this.key(kind, t), vectors[j]));
      }
      this.stats.time('alfred:embed', performance.now() - t0);
      this.stats.count('embed_texts', missing.length);
      while (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value);
    }
    this.stats.count('embed_cache_hits', texts.length - missing.length);
    return keys.map((k) => this.cache.get(k));
  }

  // items: [{ ...anything }], textOf(item) -> string. Returns the k closest
  // items with a `sim` score, or null when embeddings are not available.
  async shortlist(query, items, k, textOf, label = 'shortlist') {
    if (!this.ready || !items.length || !String(query).trim()) return null;
    try {
      const [[q], docs] = await Promise.all([this.vectors([String(query).slice(0, 2000)], 'query'), this.vectors(items.map((x) => String(textOf(x)).slice(0, 2000)), 'document')]);
      const scored = items.map((item, i) => ({ item, sim: dot(q, docs[i]) })).sort((a, b) => b.sim - a.sim);
      this.stats.count(`embed_${label}`);
      return scored.slice(0, k);
    } catch {
      this.stats.count('embed_failures');
      return null;
    }
  }
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i];
  return s;
}
