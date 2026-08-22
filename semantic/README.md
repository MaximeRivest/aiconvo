# aiconvo semantic stage (GPU server)

Late-interaction (ColBERT) search that runs on the GPU server and adds
meaning-based matches to aiconvo search. The laptop stays authoritative:
this index is a derived cache fed from the FTS unit store, and lexical
search keeps working when this service is down.

- Model: `lightonai/GTE-ModernColBERT-v1` (PyLate).
- Two stages inside the service: mean-vector cosine recall on the GPU,
  then exact MaxSim rerank on the candidates' token embeddings.
- Fully incremental: `/upsert`, `/remove` (by id or prefix), `/search`.
- Store: SQLite (`units.db`) with fp16 token embeddings.
- Multi-user: every request carries a namespace (`ns`). One namespace per
  aiconvo install. Upsert, remove, and search never cross namespaces, so
  several users share one process and one model with full isolation.

## Deployment (lambda-quad)

```bash
ssh lambda-quad
mkdir -p ~/family-ai/aiconvo-semantic && cd ~/family-ai/aiconvo-semantic
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python pylate fastapi 'uvicorn[standard]'
# copy semantic_server.py here, then:
sudo cp aiconvo-semantic.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now aiconvo-semantic
sudo ufw allow from 192.168.2.0/24 to any port 8090 proto tcp
```

The service binds `0.0.0.0:8090`, GPU 1 (`CUDA_VISIBLE_DEVICES=1`), and is
firewalled to the LAN — the same trust model as the Kokoro and Parakeet
services beside it.

### Migration from a pre-namespace store

On the first start after this update, the server moves all old rows into
one namespace. Set `SEMANTIC_DEFAULT_NS` once (in the service unit) to
the namespace of the existing user, then restart:

```ini
Environment=SEMANTIC_DEFAULT_NS=maxime
```

Without it, old rows land in the namespace `default`.

## Host side

- Enable in aiconvo settings → semantic search (off by default).
- Set the namespace in settings → semantic search. It defaults to your
  OS username. Each user on a shared server needs a unique value. A
  namespace or URL change resets the ledger and re-pushes everything.
- The host pushes changed units (titles, user and assistant messages,
  note/epic/memory sections — no tool output) through a resumable ledger
  (`semsync` table in `~/.cache/aiconvo/search.db`).
- Queries fan out: lexical FTS5 paints first; semantic hits merge in,
  marked `≈`. A dead server silently means lexical-only.
