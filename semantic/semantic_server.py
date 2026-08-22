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

API (JSON):
  GET  /health                    → {ok, model, units, device}
  POST /upsert {units:[{id,text,meta}]}         → {ok, n}
  POST /remove {ids:[...]} or {prefix:"c|key|"} → {ok, n}
  POST /search {q, limit}         → {hits:[{id, score, meta}]}
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
db.execute(
    "CREATE TABLE IF NOT EXISTS units ("
    " id TEXT PRIMARY KEY, meta TEXT, ntok INTEGER,"
    " emb BLOB, mean BLOB)"
)
db.commit()

# In-memory recall stage: ids ↔ rows of a GPU matrix of mean vectors.
ids: list = []
row_of: dict = {}
mean_matrix = torch.zeros((0, DIM), dtype=torch.float16, device=DEVICE)


def _load():
    global mean_matrix, ids, row_of
    rows = db.execute("SELECT id, mean FROM units").fetchall()
    ids = [r[0] for r in rows]
    row_of = {u: i for i, u in enumerate(ids)}
    if rows:
        m = np.stack([np.frombuffer(r[1], dtype=np.float16).copy() for r in rows])
        mean_matrix = torch.from_numpy(m).to(DEVICE)
    print(f"loaded {len(ids)} units", flush=True)


_load()


def _mean_vec(emb: np.ndarray) -> np.ndarray:
    v = emb.astype(np.float32).mean(axis=0)
    n = np.linalg.norm(v)
    return (v / n if n > 0 else v).astype(np.float16)


def _grow(n_new: int):
    """Extend the GPU matrix by n_new zero rows."""
    global mean_matrix
    pad = torch.zeros((n_new, DIM), dtype=torch.float16, device=DEVICE)
    mean_matrix = torch.cat([mean_matrix, pad], dim=0)


class UpsertBody(BaseModel):
    units: list  # [{id, text, meta}]


class RemoveBody(BaseModel):
    ids: list | None = None
    prefix: str | None = None


class SearchBody(BaseModel):
    q: str
    limit: int = 30


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_NAME, "units": len(row_of), "device": DEVICE}


@app.post("/upsert")
def upsert(body: UpsertBody):
    global mean_matrix
    units = [u for u in body.units if u.get("id") and str(u.get("text", "")).strip()]
    if not units:
        return {"ok": True, "n": 0}
    texts = [str(u["text"])[:8000] for u in units]
    with lock:
        embs = model.encode(texts, is_query=False, batch_size=32, show_progress_bar=False)
        new = [u for u in units if u["id"] not in row_of]
        if new:
            _grow(len(new))
            for u in new:
                row_of[u["id"]] = len(ids)
                ids.append(u["id"])
        for u, emb in zip(units, embs):
            emb16 = emb.astype(np.float16)
            mv = _mean_vec(emb16)
            db.execute(
                "INSERT INTO units (id, meta, ntok, emb, mean) VALUES (?,?,?,?,?)"
                " ON CONFLICT(id) DO UPDATE SET meta=excluded.meta, ntok=excluded.ntok,"
                " emb=excluded.emb, mean=excluded.mean",
                (u["id"], json.dumps(u.get("meta") or {}), emb16.shape[0],
                 emb16.tobytes(), mv.tobytes()),
            )
            mean_matrix[row_of[u["id"]]] = torch.from_numpy(mv.copy()).to(DEVICE)
        db.commit()
    return {"ok": True, "n": len(units)}


@app.post("/remove")
def remove(body: RemoveBody):
    with lock:
        if body.prefix:
            gone = [r[0] for r in db.execute(
                "SELECT id FROM units WHERE id LIKE ? || '%'", (body.prefix,)).fetchall()]
        else:
            gone = [i for i in (body.ids or []) if i in row_of]
        for uid in gone:
            db.execute("DELETE FROM units WHERE id = ?", (uid,))
            row = row_of.pop(uid, None)
            if row is not None:
                mean_matrix[row] = 0  # dead row: recalls nothing; compacted on restart
                ids[row] = None
        db.commit()
    return {"ok": True, "n": len(gone)}


@app.post("/search")
def search(body: SearchBody):
    q = body.q.strip()
    if not q or not row_of:
        return {"hits": []}
    with lock:
        qemb = model.encode([q], is_query=True)[0].astype(np.float32)
        qt = torch.from_numpy(qemb).to(DEVICE, dtype=torch.float16)
        qmean = qt.mean(dim=0)
        qmean = qmean / (qmean.norm() + 1e-6)
        # Stage 1: cosine recall over mean vectors.
        scores = mean_matrix @ qmean
        k = min(RECALL_K, scores.shape[0])
        top = torch.topk(scores, k)
        cand = [ids[i] for i in top.indices.tolist() if ids[i] is not None]
        # Stage 2: exact MaxSim on the candidates' token embeddings.
        hits = []
        for uid in cand:
            row = db.execute("SELECT meta, ntok, emb FROM units WHERE id = ?", (uid,)).fetchone()
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
