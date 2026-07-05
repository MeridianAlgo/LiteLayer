"""
Zero-shot photo classifier for the Photo Inbox — CLIP ViT-B/32, quantized ONNX.

Light enough for a Pi (~170 MB on disk, CPU-only, ~1s per photo on a Pi 4/5),
smart enough to sort into arbitrary user-named folders with no training: each
category is a folder name + optional hint, embedded as text and matched
against the photo (OpenAI CLIP zero-shot, via Xenova's ONNX export).

The heavy deps (onnxruntime, pillow, tokenizers) and the model download happen
on demand from Settings → Photo Inbox, so the base install stays light.
Nothing here imports them at module load time.
"""
import os
import subprocess
import sys
import threading
import urllib.request
from pathlib import Path

MODEL_DIR = Path(os.environ.get("LITELAYER_MODEL_DIR", "/var/lib/litelayer/models")) / "clip-vit-b32"
_HF = "https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/main"
_FILES = {
    "model.onnx": f"{_HF}/onnx/model_quantized.onnx",   # full CLIP: image+text in one session
    "tokenizer.json": f"{_HF}/tokenizer.json",
}
_PIP_DEPS = ["onnxruntime", "pillow", "pillow-heif", "tokenizers", "numpy"]

# CLIP preprocessing constants (image normalization, context length, pad token)
_MEAN = (0.48145466, 0.4578275, 0.40821073)
_STD = (0.26862954, 0.26130258, 0.27577711)
_CTX = 77
_PAD_ID = 49407  # <|endoftext|>

_state = {"installing": False, "step": "", "progress": 0.0, "error": None}
_lock = threading.Lock()
_sess = None
_tok = None


def deps_ok() -> bool:
    try:
        import onnxruntime, tokenizers, PIL  # noqa: F401
        return True
    except ImportError:
        return False


def model_ok() -> bool:
    return all((MODEL_DIR / f).exists() for f in _FILES)


def is_ready() -> bool:
    return deps_ok() and model_ok()


def status() -> dict:
    return {**_state, "ready": is_ready(), "model_dir": str(MODEL_DIR)}


def start_setup() -> bool:
    """Kick off dependency install + model download in the background.
    Returns False if a setup is already running."""
    with _lock:
        if _state["installing"]:
            return False
        _state.update(installing=True, step="Starting…", progress=0.0, error=None)
    threading.Thread(target=_setup_worker, daemon=True, name="photo-ai-setup").start()
    return True


def _setup_worker() -> None:
    try:
        if not deps_ok():
            _state["step"] = "Installing Python packages (onnxruntime, pillow…)"
            r = subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", *_PIP_DEPS],
                               capture_output=True, text=True, timeout=1800)
            if r.returncode != 0:
                tail = (r.stderr or r.stdout or "").strip().splitlines()[-3:]
                _state["error"] = "Package install failed: " + " | ".join(tail)
                return
        MODEL_DIR.mkdir(parents=True, exist_ok=True)
        for i, (name, url) in enumerate(_FILES.items()):
            dest = MODEL_DIR / name
            if dest.exists():
                continue
            _state["step"] = f"Downloading model ({name})"
            part = dest.with_suffix(dest.suffix + ".part")

            def _hook(blocks, bsize, total, _i=i):
                if total > 0:
                    frac = min(1.0, blocks * bsize / total)
                    _state["progress"] = (_i + frac) / len(_FILES)

            urllib.request.urlretrieve(url, part, reporthook=_hook)
            part.rename(dest)
        _state["step"] = "Loading model"
        _load()
        _state.update(step="Ready", progress=1.0)
    except Exception as exc:  # noqa: BLE001
        _state["error"] = str(exc)
    finally:
        _state["installing"] = False


def _load() -> None:
    """Load the ONNX session + tokenizer once. Raises if setup hasn't run."""
    global _sess, _tok
    if _sess is not None:
        return
    import onnxruntime
    from tokenizers import Tokenizer
    try:  # iPhone photos are often HEIC — open them if pillow-heif made it in
        from pillow_heif import register_heif_opener
        register_heif_opener()
    except ImportError:
        pass
    _sess = onnxruntime.InferenceSession(str(MODEL_DIR / "model.onnx"),
                                         providers=["CPUExecutionProvider"])
    _tok = Tokenizer.from_file(str(MODEL_DIR / "tokenizer.json"))
    _tok.enable_padding(length=_CTX, pad_id=_PAD_ID, pad_token="<|endoftext|>")
    _tok.enable_truncation(max_length=_CTX)


def _pixel_values(path: Path):
    """CLIP image preprocessing: shortest side → 224, center crop, normalize."""
    import numpy as np
    from PIL import Image
    img = Image.open(path).convert("RGB")
    s = 224 / min(img.size)
    img = img.resize((max(224, round(img.width * s)), max(224, round(img.height * s))),
                     Image.BICUBIC)
    left, top = (img.width - 224) // 2, (img.height - 224) // 2
    img = img.crop((left, top, left + 224, top + 224))
    x = np.asarray(img, dtype=np.float32) / 255.0
    x = (x - np.array(_MEAN, dtype=np.float32)) / np.array(_STD, dtype=np.float32)
    return x.transpose(2, 0, 1)[None]


def classify(path: Path, categories: list[dict], threshold: float = 0.2) -> "str | None":
    """Pick the best-matching category name for a photo, or None if nothing
    matches well enough. categories: [{"name": ..., "hint": ...}, ...]."""
    if not categories:
        return None
    import numpy as np
    with _lock:
        _load()
    prompts = [f"a photo of {c.get('hint') or c['name']}" for c in categories]
    enc = _tok.encode_batch(prompts)
    feed = {
        "input_ids": np.array([e.ids for e in enc], dtype=np.int64),
        "attention_mask": np.array([e.attention_mask for e in enc], dtype=np.int64),
        "pixel_values": _pixel_values(path),
    }
    wanted = {i.name for i in _sess.get_inputs()}
    logits = _sess.run(["logits_per_image"], {k: v for k, v in feed.items() if k in wanted})[0][0]
    best = int(np.argmax(logits))
    # logits = 100 × cosine similarity; below the floor nothing really matched.
    if logits[best] / 100.0 < threshold:
        return None
    return categories[best]["name"]
