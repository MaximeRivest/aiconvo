#!/usr/bin/env python3
"""aiconvo semantic search — late-interaction (ColBERT) stage.

Runs on the GPU server. Aiconvo pushes text units (messages, titles,
note/epic/memory sections); queries return ranked unit ids with scores.

Design: two stages inside the service.
  1. Recall — one mean-pooled vector per unit, cosine top-K on the GPU.
  2. Rerank — exact MaxSim late interaction on the K candidates' full
     token embeddings (loaded per candidate from SQLite).

This stays fully incremental (upsert / remove single units) and avoids
static-index rebuilds. The store is a derived cache: aiconvo can re-push
everything at any time.

Multi-user: every unit lives in a namespace (`ns`). One namespace per
aiconvo install. Upsert, remove, and search never cross namespaces, so
several users can share one GPU process and one model without mixing
their indexes.

API (JSON, every body takes an optional `ns`, default "default"):
  GET  /health                    → {ok, model, units, spaces, device}
  POST /upsert {ns, units:[{id,text,meta}]}         → {ok, n}
  POST /remove {ns, ids:[...]} or {ns, prefix:"c|key|"} → {ok, n}
  POST /search {ns, q, limit}     → {hits:[{id, score, meta}]}
"""
import json
import os
import sqlite3
import threading
import time

import numpy as np
import torch
from fastapi import FastAPI
from pydantic import BaseModel

MODEL_NAME = os.environ.get("SEMANTIC_MODEL", "lightonai/GTE-ModernColBERT-v1")
DB_PATH = os.path.expanduser(os.environ.get("SEMANTIC_DB", "~/family-ai/aiconvo-semantic/units.db"))
DOC_LEN = int(os.environ.get("SEMANTIC_DOC_LEN", "512"))
RECALL_K = int(os.environ.get("SEMANTIC_RECALL_K", "256"))
# Rows from a pre-namespace store land in this namespace on first start.
DEFAULT_NS = os.environ.get("SEMANTIC_DEFAULT_NS", "default")
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

app = FastAPI()
lock = threading.Lock()

print(f"loading {MODEL_NAME} on {DEVICE} …", flush=True)
t0 = time.time()
from pylate import models  # noqa: E402  (import after banner: it is slow)

model = models.ColBERT(model_name_or_path=MODEL_NAME, device=DEVICE, document_length=DOC_LEN)
DIM = model.encode(["warmup"], is_query=False)[0].shape[1]
print(f"model ready in {time.time() - t0:.1f}s · dim {DIM}", flush=True)

db = sqlite3.connect(DB_PATH, check_same_thread=False)


def _migrate():
    """Create the store; move a pre-namespace table under DEFAULT_NS."""
    cols = [r[1] for r in db.execute("PRAGMA table_info(units)").fetchall()]
    if cols and "ns" not in cols:
        print(f"migrating {DB_PATH}: old rows → ns '{DEFAULT_NS}'", flush=True)
        db.execute("ALTER TABLE units RENAME TO units_old")
        cols = []
    if not cols:
        db.execute(
            "CREATE TABLE IF NOT EXISTS units ("
            " ns TEXT NOT NULL, id TEXT NOT NULL, meta TEXT, ntok INTEGER,"
            " emb BLOB, mean BLOB, PRIMARY KEY (ns, id))"
        )
    old = db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='units_old'").fetchone()
    if old:
        db.execute(
            "INSERT OR REPLACE INTO units (ns, id, meta, ntok, emb, mean)"
            " SELECT ?, id, meta, ntok, emb, mean FROM units_old", (DEFAULT_NS,))
        db.execute("DROP TABLE units_old")
    db.commit()


_migrate()


class Space:
    """In-memory recall stage for one namespace: ids ↔ GPU mean-vector rows."""

    def __init__(self):
        self.ids: list = []
        self.row_of: dict = {}
        self.mean = torch.zeros((0, DIM), dtype=torch.float16, device=DEVICE)

    def grow(self, n_new: int):
        pad = torch.zeros((n_new, DIM), dtype=torch.float16, device=DEVICE)
        self.mean = torch.cat([self.mean, pad], dim=0)


spaces: dict = {}


def space(ns: str) -> Space:
    sp = spaces.get(ns)
    if sp is None:
        sp = spaces[ns] = Space()
    return sp


def _load():
    rows = db.execute("SELECT ns, id, mean FROM units").fetchall()
    by_ns: dict = {}
    for ns, uid, mean in rows:
        by_ns.setdefault(ns, []).append((uid, mean))
    for ns, items in by_ns.items():
        sp = space(ns)
        sp.ids = [u for u, _ in items]
        sp.row_of = {u: i for i, u in enumerate(sp.ids)}
        m = np.stack([np.frombuffer(b, dtype=np.float16).copy() for _, b in items])
        sp.mean = torch.from_numpy(m).to(DEVICE)
    counts = {ns: len(sp.ids) for ns, sp in spaces.items()}
    print(f"loaded {len(rows)} units · {counts}", flush=True)


_load()


def _mean_vec(emb: np.ndarray) -> np.ndarray:
    v = emb.astype(np.float32).mean(axis=0)
    n = np.linalg.norm(v)
    return (v / n if n > 0 else v).astype(np.float16)


class UpsertBody(BaseModel):
    units: list  # [{id, text, meta}]
    ns: str = "default"


class RemoveBody(BaseModel):
    ids: list | None = None
    prefix: str | None = None
    ns: str = "default"


class SearchBody(BaseModel):
    q: str
    limit: int = 30
    ns: str = "default"


@app.get("/health")
def health():
    counts = {ns: len(sp.row_of) for ns, sp in spaces.items()}
    return {"ok": True, "model": MODEL_NAME, "units": sum(counts.values()),
            "spaces": counts, "device": DEVICE}


@app.post("/upsert")
def upsert(body: UpsertBody):
    units = [u for u in body.units if u.get("id") and str(u.get("text", "")).strip()]
    if not units:
        return {"ok": True, "n": 0}
    texts = [str(u["text"])[:8000] for u in units]
    with lock:
        sp = space(body.ns)
        embs = model.encode(texts, is_query=False, batch_size=32, show_progress_bar=False)
        new = [u for u in units if u["id"] not in sp.row_of]
        if new:
            sp.grow(len(new))
            for u in new:
                sp.row_of[u["id"]] = len(sp.ids)
                sp.ids.append(u["id"])
        for u, emb in zip(units, embs):
            emb16 = emb.astype(np.float16)
            mv = _mean_vec(emb16)
            db.execute(
                "INSERT INTO units (ns, id, meta, ntok, emb, mean) VALUES (?,?,?,?,?,?)"
                " ON CONFLICT(ns, id) DO UPDATE SET meta=excluded.meta, ntok=excluded.ntok,"
                " emb=excluded.emb, mean=excluded.mean",
                (body.ns, u["id"], json.dumps(u.get("meta") or {}), emb16.shape[0],
                 emb16.tobytes(), mv.tobytes()),
            )
            sp.mean[sp.row_of[u["id"]]] = torch.from_numpy(mv.copy()).to(DEVICE)
        db.commit()
    return {"ok": True, "n": len(units)}


@app.post("/remove")
def remove(body: RemoveBody):
    with lock:
        sp = space(body.ns)
        if body.prefix:
            gone = [r[0] for r in db.execute(
                "SELECT id FROM units WHERE ns = ? AND id LIKE ? || '%'",
                (body.ns, body.prefix)).fetchall()]
        else:
            gone = [i for i in (body.ids or []) if i in sp.row_of]
        for uid in gone:
            db.execute("DELETE FROM units WHERE ns = ? AND id = ?", (body.ns, uid))
            row = sp.row_of.pop(uid, None)
            if row is not None:
                sp.mean[row] = 0  # dead row: recalls nothing; compacted on restart
                sp.ids[row] = None
        db.commit()
    return {"ok": True, "n": len(gone)}


@app.post("/search")
def search(body: SearchBody):
    q = body.q.strip()
    sp = spaces.get(body.ns)
    if not q or sp is None or not sp.row_of:
        return {"hits": []}
    with lock:
        qemb = model.encode([q], is_query=True)[0].astype(np.float32)
        qt = torch.from_numpy(qemb).to(DEVICE, dtype=torch.float16)
        qmean = qt.mean(dim=0)
        qmean = qmean / (qmean.norm() + 1e-6)
        # Stage 1: cosine recall over mean vectors.
        scores = sp.mean @ qmean
        k = min(RECALL_K, scores.shape[0])
        top = torch.topk(scores, k)
        cand = [sp.ids[i] for i in top.indices.tolist() if sp.ids[i] is not None]
        # Stage 2: exact MaxSim on the candidates' token embeddings.
        hits = []
        for uid in cand:
            row = db.execute(
                "SELECT meta, ntok, emb FROM units WHERE ns = ? AND id = ?",
                (body.ns, uid)).fetchone()
            if not row:
                continue
            demb = torch.from_numpy(
                np.frombuffer(row[2], dtype=np.float16).copy().reshape(row[1], DIM)
            ).to(DEVICE)
            maxsim = (qt @ demb.T).max(dim=1).values.sum().item()
            hits.append({"id": uid, "score": round(maxsim, 4), "meta": json.loads(row[0] or "{}")})
        hits.sort(key=lambda h: -h["score"])
    return {"hits": hits[: max(1, min(200, body.limit))]}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("SEMANTIC_PORT", "8090")))
