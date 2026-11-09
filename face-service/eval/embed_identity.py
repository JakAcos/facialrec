"""Write face templates for one LFW identity to a JSON file.

The browser tests use this to enroll a test account with a face that is
not the one in front of the camera, so they can check that a different
live person is rejected.

Usage: python eval/embed_identity.py <output.json>
"""

import json
import sys
from pathlib import Path

import cv2
import numpy as np
from sklearn.datasets import fetch_lfw_people

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.pipeline import Pipeline  # noqa: E402


def main(out: Path) -> None:
    data = fetch_lfw_people(min_faces_per_person=20, color=True, resize=1.0, slice_=None)
    person = int(np.unique(data.target)[0])
    images = data.images[data.target == person][:3]
    pipeline = Pipeline()
    templates = []
    for image in images:
        if image.max() <= 1.0:
            image = image * 255.0
        bgr = cv2.cvtColor(image.astype(np.uint8), cv2.COLOR_RGB2BGR)
        result = pipeline.analyze(bgr)
        if result.embedding:
            templates.append(result.embedding)
    if len(templates) < 2:
        raise SystemExit("could not embed enough images")
    out.write_text(json.dumps({"name": str(data.target_names[person]), "templates": templates}))
    print("wrote", out, "for", data.target_names[person])


if __name__ == "__main__":
    main(Path(sys.argv[1]))
