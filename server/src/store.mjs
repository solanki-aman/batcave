// Batcave store: a single JSON document, kept in memory and flushed to disk.
// Good enough for a team of tens. Swap for Postgres when it is not.
import fs from 'node:fs';
import path from 'node:path';

const EMPTY = () => ({
  version: 1,
  seq: { task: 0, msg: 0, dec: 0, req: 0, hand: 0 },
  people: {},      // id -> person
  tasks: {},       // "T-1" -> task
  rooms: {},       // room id -> room
  messages: [],    // room messages, newest last
  decisions: [],   // pinned decisions
  requests: [],    // asks addressed to someone's Claude
  handoffs: [],    // task handoff packets
  touches: [],     // file edits, for the guard
});

const MAX_MESSAGES = 5000;
const TOUCH_TTL_MS = 24 * 60 * 60 * 1000;

export class Store {
  constructor(file) {
    this.file = file;
    this.data = EMPTY();
    this.timer = null;
    if (file && fs.existsSync(file)) {
      try {
        this.data = { ...EMPTY(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
      } catch (err) {
        console.error(`[batcave] could not read ${file}, starting empty:`, err.message);
      }
    }
  }

  nextId(kind) {
    this.data.seq[kind] = (this.data.seq[kind] || 0) + 1;
    return this.data.seq[kind];
  }

  pushMessage(msg) {
    this.data.messages.push(msg);
    if (this.data.messages.length > MAX_MESSAGES) {
      this.data.messages.splice(0, this.data.messages.length - MAX_MESSAGES);
    }
  }

  pruneTouches(now = Date.now()) {
    this.data.touches = this.data.touches.filter((t) => now - t.at < TOUCH_TTL_MS);
  }

  save() {
    if (!this.file) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 250);
  }

  flush() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }
}
