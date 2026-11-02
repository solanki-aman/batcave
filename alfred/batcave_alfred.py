#!/usr/bin/env python3
"""Batcave Alfred: a local HTTP sidecar around the Julia-1 decision model.

Julia-1 (Supersonic Labs, Apache-2.0) picks among supplied answers instead of
generating text, and runs on CPU. Batcave uses it for bounded, advisory calls:
ranking which team notes are relevant to a prompt, and spotting decisions in chat.

    python batcave_alfred.py --model ~/.batcave/alfred/Julia-1 [--embed ~/.batcave/alfred/embeddinggemma-2] [--port 4778] [--device cpu]

With --embed, Alfred also loads an embedding model (EmbeddingGemma 2 by default)
and shortlists candidates by similarity before Julia-1 decides among a few.

Endpoints
    GET  /health  -> {"ok": true, "loaded": true, "model": "Julia-1", "device": "cpu", "load_ms": 2140}
    POST /decide  {"state": "...", "questions": {name: {...}}} -> {"answers": {...}, "ms": 41.2}
    POST /embed   {"texts": [...], "kind": "query"|"document", "dims": 256} -> {"vectors": [[...]], "ms": 8.1}
    GET  /stats   -> call count and latency percentiles

Only the Python standard library is used here; the model package brings its own deps.
"""
import argparse
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATE = {"engine": None, "loaded": False, "error": None, "load_ms": None, "model": None, "device": None}
EMBED = {"model": None, "name": None, "loaded": False, "error": None, "load_ms": None}
ELOCK = threading.Lock()
# EmbeddingGemma 2 is trained with short task prefixes on its inputs.
PREFIX = {"query": "task: search result | query: ", "document": "title: none | text: "}
LOCK = threading.Lock()
TIMES = []


def load(model_path, device, max_length):
    t0 = time.perf_counter()
    try:
        sys.path.insert(0, model_path)  # the checkpoint ships its own `julia` package
        from julia import load_model  # type: ignore
        kwargs = dict(device=device, strict_encoding=True, max_length=max_length, head_length=512)
        try:
            engine = load_model(model_path, **kwargs)
        except TypeError:
            engine = load_model(model_path, device=device)
        # warm up once so the first real request is fast
        engine.predict(state="warm up", questions={"w": {"type": "noul", "instructions": "Is this a warm up?"}})
        STATE.update(engine=engine, loaded=True, load_ms=round((time.perf_counter() - t0) * 1000))
        print(f"[batcave-alfred] loaded {model_path} on {device} in {STATE['load_ms']} ms", flush=True)
    except Exception as e:  # keep serving /health with the error so Batcave can fall back
        STATE.update(error=f"{type(e).__name__}: {e}")
        print(f"[batcave-alfred] failed to load model: {STATE['error']}", file=sys.stderr, flush=True)


def load_embed(path, device):
    t0 = time.perf_counter()
    try:
        from sentence_transformers import SentenceTransformer  # type: ignore
        EMBED.update(model=SentenceTransformer(path, device=device), loaded=True, load_ms=round((time.perf_counter() - t0) * 1000))
        print(f"[batcave-alfred] loaded embeddings {path} in {EMBED['load_ms']} ms", flush=True)
    except Exception as e:
        EMBED.update(error=f"{type(e).__name__}: {e}")
        print(f"[batcave-alfred] failed to load embeddings: {EMBED['error']}", file=sys.stderr, flush=True)


def embed(texts, kind, dims):
    vecs = EMBED["model"].encode([PREFIX.get(kind, "") + t for t in texts], convert_to_numpy=True)
    vecs = vecs[:, :dims]  # Matryoshka: the leading dimensions carry most of the meaning
    norms = (vecs ** 2).sum(axis=1, keepdims=True) ** 0.5
    return (vecs / (norms + 1e-12)).round(5).tolist()


def to_plain(x):
    """Turn tensors/numpy values into JSON-safe Python values."""
    if isinstance(x, dict):
        return {str(k): to_plain(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [to_plain(v) for v in x]
    if hasattr(x, "tolist"):
        return x.tolist()
    if hasattr(x, "item"):
        return x.item()
    return x


def pct(values, p):
    if not values:
        return None
    s = sorted(values)
    return s[min(len(s) - 1, int(p * len(s)))]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # quiet by default
        if os.environ.get("BATCAVE_ALFRED_DEBUG"):
            super().log_message(fmt, *args)

    def send(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            return self.send(200, {"ok": STATE["error"] is None, "loaded": STATE["loaded"], "model": STATE["model"],
                                   "device": STATE["device"], "load_ms": STATE["load_ms"], "error": STATE["error"],
                                   "embed": EMBED["loaded"], "embed_model": EMBED["name"], "embed_error": EMBED["error"]})
        if self.path == "/stats":
            recent = TIMES[-500:]
            return self.send(200, {"calls": len(TIMES), "p50_ms": pct(recent, 0.5), "p95_ms": pct(recent, 0.95)})
        self.send(404, {"error": "no such route"})

    def do_POST(self):
        if self.path == "/embed":
            return self.do_embed()
        if self.path != "/decide":
            return self.send(404, {"error": "no such route"})
        if not STATE["loaded"]:
            return self.send(503, {"error": STATE["error"] or "model is still loading"})
        try:
            length = int(self.headers.get("content-length") or 0)
            if length > 200_000:
                return self.send(413, {"error": "request too large"})
            req = json.loads(self.rfile.read(length) or b"{}")
            state, questions = str(req.get("state", ""))[:8000], req.get("questions") or {}
            if not isinstance(questions, dict) or not questions or len(questions) > 40:
                return self.send(400, {"error": "questions must be an object with 1 to 40 entries"})
            t0 = time.perf_counter()
            with LOCK:  # one inference at a time; the model is small and fast
                result = STATE["engine"].predict(state=state, questions=questions)
            ms = round((time.perf_counter() - t0) * 1000, 1)
            TIMES.append(ms)
            del TIMES[:-2000]
            result = to_plain(result)
            return self.send(200, {"answers": result.get("answers", result), "ms": ms})
        except Exception as e:
            return self.send(500, {"error": f"{type(e).__name__}: {e}"})


    def do_embed(self):
        if not EMBED["loaded"]:
            return self.send(503, {"error": EMBED["error"] or "no embedding model (start with --embed)"})
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
            texts = [str(t)[:4000] for t in (req.get("texts") or [])][:256]
            dims = int(req.get("dims") or 256)
            if not texts:
                return self.send(400, {"error": "texts must be a non-empty list"})
            t0 = time.perf_counter()
            with ELOCK:
                vectors = embed(texts, req.get("kind", "document"), dims)
            return self.send(200, {"vectors": vectors, "ms": round((time.perf_counter() - t0) * 1000, 1)})
        except Exception as e:
            return self.send(500, {"error": f"{type(e).__name__}: {e}"})


def main():
    ap = argparse.ArgumentParser(description="Batcave Alfred: Julia-1 decision model sidecar")
    ap.add_argument("--model", default=os.path.expanduser("~/.batcave/alfred/Julia-1"))
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=4778)
    ap.add_argument("--device", default=os.environ.get("BATCAVE_ALFRED_DEVICE", "cpu"))
    ap.add_argument("--max-length", type=int, default=1024)
    ap.add_argument("--embed", default="", help="path or Hugging Face id of an embedding model, e.g. google/embeddinggemma-2")
    a = ap.parse_args()
    STATE.update(model=os.path.basename(a.model.rstrip("/")), device=a.device)
    threading.Thread(target=load, args=(a.model, a.device, a.max_length), daemon=True).start()
    if a.embed:
        EMBED.update(name=os.path.basename(a.embed.rstrip("/")))
        threading.Thread(target=load_embed, args=(a.embed, a.device), daemon=True).start()
    print(f"[batcave-alfred] listening on http://{a.host}:{a.port} (loading model...)", flush=True)
    ThreadingHTTPServer((a.host, a.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
