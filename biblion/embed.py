"""
biblion -> network-toy embedding (step 2 of 2).

Runs SPECTER2 (allenai/specter2_base + proximity adapter) over the node set
produced by snapshot.run_snapshot, in the SAME order, and writes a (n, 768)
float32 `embeddings.npy` that the toy reads via datasource/sqlite.js.

Contract: row i of embeddings.npy == row i of nodes.jsonl == paper_index["i"].
Verified before writing.

Text fed to the model is `title [SEP] abstract`, raw -- no domain abbreviation
expansion. (That dictionary-substitution approach was removed: its always-fire
entries for short overloaded tokens, e.g. soil `as`->arsenic, corrupted the
English word "as" and misfired across fields.)

torch / transformers / adapters are heavy and GPU-oriented, so they are an
OPTIONAL dependency (`pip install 'biblion[embed]'`) imported lazily inside
_embed(); the rest of biblion never pulls them in.
"""
import json
from pathlib import Path

SPECTER2_MODEL = "allenai/specter2_base"
SPECTER2_ADAPTER = "allenai/specter2"
BATCH_SIZE = 32
MAX_LENGTH = 512

_INSTALL_HINT = (
    "SPECTER2 embedding needs the optional 'embed' extra. Install it with:\n"
    "    pip install 'biblion[embed]'\n"
    "(pulls in torch + transformers + adapters + numpy)"
)


def load_nodes(jsonl_path: Path):
    nodes = []
    with open(jsonl_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                nodes.append(json.loads(line))
    # The file is written in row order; assert it to catch any tampering.
    for i, nd in enumerate(nodes):
        if nd.get("row") != i:
            raise ValueError(f"row order mismatch at line {i}: row={nd.get('row')}")
    return nodes


def _embed(nodes, batch_size, max_length, device=None):
    try:
        import torch
        from transformers import AutoTokenizer
        from adapters import AutoAdapterModel
    except ImportError as e:
        raise SystemExit(f"[embed] {e}\n\n{_INSTALL_HINT}")
    import numpy as np

    print(f"[embed] loading {SPECTER2_MODEL} + adapter {SPECTER2_ADAPTER}")
    tok = AutoTokenizer.from_pretrained(SPECTER2_MODEL)
    model = AutoAdapterModel.from_pretrained(SPECTER2_MODEL)
    model.load_adapter(SPECTER2_ADAPTER, source="hf", set_active=True)
    model.eval()

    # The adapters lib prints a spurious "none are activated" warning during
    # init even when the adapter IS active. FAIL LOUD if it really isn't --
    # without the proximity adapter the vectors are base-BERT, not SPECTER2.
    active = model.active_adapters
    print(f"[embed] active adapter: {active}")
    if not active:
        raise SystemExit("[embed] proximity adapter NOT active -- aborting "
                         "(embeddings would be base model, not SPECTER2)")

    device = device or ("cuda" if torch.cuda.is_available() else "cpu")
    model.to(device)
    print(f"[embed] device={device}  n={len(nodes)}")

    try:
        from tqdm import tqdm
    except ImportError:
        def tqdm(it, **k):
            return it

    sep = tok.sep_token
    texts = [f"{nd['title']} {sep} {nd['abstract']}" for nd in nodes]

    out = []
    for i in tqdm(range(0, len(texts), batch_size), desc="embedding"):
        batch = texts[i:i + batch_size]
        enc = tok(batch, padding=True, truncation=True,
                  max_length=max_length, return_tensors="pt").to(device)
        with torch.no_grad():
            res = model(**enc)
        # SPECTER2 document embedding = [CLS] token of the last hidden state.
        out.append(res.last_hidden_state[:, 0, :].cpu().numpy())
    return np.vstack(out).astype(np.float32)


def run_embed(db_path: Path, dataset: str | None = None, out_dir: Path | None = None,
              in_path: Path | None = None, out_path: Path | None = None,
              batch=BATCH_SIZE, max_length=MAX_LENGTH, device=None) -> Path:
    """Embed the node set written by run_snapshot. Defaults mirror snapshot:
    out_dir = the DB's parent, reading nodes.jsonl and writing embeddings.npy
    there. Returns the path to the written .npy."""
    import numpy as np

    src = Path(db_path).expanduser().resolve()
    out = Path(out_dir).expanduser().resolve() if out_dir else src.parent
    inp = Path(in_path) if in_path else out / "nodes.jsonl"
    outp = Path(out_path) if out_path else out / "embeddings.npy"

    if not inp.exists():
        raise FileNotFoundError(
            f"input not found: {inp} (run `biblion advanced snapshot` first)")

    nodes = load_nodes(inp)
    emb = _embed(nodes, batch, max_length, device)
    if emb.shape[0] != len(nodes):
        raise ValueError(f"row count mismatch: emb={emb.shape[0]} nodes={len(nodes)}")

    outp.parent.mkdir(parents=True, exist_ok=True)
    np.save(outp, emb)
    print(f"[embed] wrote {outp}  shape={emb.shape}  dtype={emb.dtype}")

    # Stamp the manifest if present.
    man_path = outp.parent / "manifest.json"
    if man_path.exists():
        man = json.loads(man_path.read_text())
        man.update({
            "embedding_model": SPECTER2_MODEL,
            "embedding_adapter": SPECTER2_ADAPTER,
            "embedding_dim": int(emb.shape[1]),
        })
        if man.get("n_nodes") not in (None, emb.shape[0]):
            print(f"[embed] WARNING manifest n_nodes={man['n_nodes']} != {emb.shape[0]}")
        # fsync: the data dir is on a OneDrive mount whose lazy write-back can
        # otherwise silently revert this stamp to the pre-embed version.
        import os
        with open(man_path, "w") as f:
            json.dump(man, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        print(f"[embed] stamped {man_path}")
    return outp
