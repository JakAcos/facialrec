"""Download the InsightFace detection and recognition models.

They are too large for git (about 190 MB), so the Docker build and local
setup fetch them from the official InsightFace release and check their
SHA-256 hashes.

Usage: python scripts/download_models.py <models dir>

Licence note: the pretrained InsightFace models are for non-commercial
research use only.
"""

import hashlib
import io
import sys
import urllib.request
import zipfile
from pathlib import Path

URL = "https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip"
WANTED = {
    "det_10g.onnx": "5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91",
    "w600k_r50.onnx": "4c06341c33c2ca1f86781dab0e829f88ad5b64be9fba56e56bc9ebdefc619e43",
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main(out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    if all((out_dir / n).exists() and sha256(out_dir / n) == h for n, h in WANTED.items()):
        print("models already present")
        return
    print("downloading", URL)
    with urllib.request.urlopen(URL) as response:
        archive = zipfile.ZipFile(io.BytesIO(response.read()))
    for member in archive.namelist():
        name = member.split("/")[-1]
        if name in WANTED:
            target = out_dir / name
            target.write_bytes(archive.read(member))
            if sha256(target) != WANTED[name]:
                target.unlink()
                raise SystemExit(f"hash mismatch for {name}")
            print("wrote", target)


if __name__ == "__main__":
    main(Path(sys.argv[1]))
