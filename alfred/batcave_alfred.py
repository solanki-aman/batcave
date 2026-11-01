#!/usr/bin/env python3
"""Batcave Alfred: a local HTTP sidecar around the Julia-1 decision model.

Julia-1 (Supersonic Labs, Apache-2.0) picks among supplied answers instead of
generating text, and runs on CPU. Batcave uses it for bounded, advisory calls:
ranking which team notes are relevant to a prompt, and spotting decisions in chat.

    python batcave_alfred.py --model ~/.batcave/alfred/Julia-1 [--port 4778] [--device cpu]

Endpoints
    GET  /health  -> {"ok": true, "loaded": true, "model": "Julia-1", "device": "cpu", "load_ms": 2140}
    POST /decide  {"state": "...", "questions": {name: {...}}} -> {"answers": {...}, "ms": 41.2}
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
                                   "device": STATE["device"], "load_ms": STATE["load_ms"], "error": STATE["error"]})
        if self.path == "/stats":
            recent = TIMES[-500:]
            return self.send(200, {"calls": len(TIMES), "p50_ms": pct(recent, 0.5), "p95_ms": pct(recent, 0.95)})
        self.send(404, {"error": "no such route"})

    def do_POST(self):
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


def main():
    ap = argparse.ArgumentParser(description="Batcave Alfred: Julia-1 decision model sidecar")
    ap.add_argument("--model", default=os.path.expanduser("~/.batcave/alfred/Julia-1"))
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=4778)
    ap.add_argument("--device", default=os.environ.get("BATCAVE_ALFRED_DEVICE", "cpu"))
    ap.add_argument("--max-length", type=int, default=1024)
    a = ap.parse_args()
    STATE.update(model=os.path.basename(a.model.rstrip("/")), device=a.device)
    threading.Thread(target=load, args=(a.model, a.device, a.max_length), daemon=True).start()
    print(f"[batcave-alfred] listening on http://{a.host}:{a.port} (loading model...)", flush=True)
    ThreadingHTTPServer((a.host, a.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
