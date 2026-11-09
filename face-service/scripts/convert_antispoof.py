"""Convert the Silent-Face-Anti-Spoofing PyTorch weights to ONNX.

The two small models in face-service/models/ were produced by this script
from the official repository (Apache-2.0):
https://github.com/minivision-ai/Silent-Face-Anti-Spoofing

Usage (needs torch and onnx, which the service itself does not):
    python convert_antispoof.py <path to cloned repo> <output dir>
"""

import importlib.util
import sys
from collections import OrderedDict
from pathlib import Path

import torch

MODELS = {
    "2.7_80x80_MiniFASNetV2.pth": ("MiniFASNetV2", "antispoof_v2_2.7.onnx"),
    "4_0_0_80x80_MiniFASNetV1SE.pth": ("MiniFASNetV1SE", "antispoof_v1se_4.0.onnx"),
}


def main(repo: Path, out_dir: Path) -> None:
    spec = importlib.util.spec_from_file_location(
        "minifasnet", repo / "src" / "model_lib" / "MiniFASNet.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    out_dir.mkdir(parents=True, exist_ok=True)
    for weights_name, (arch, onnx_name) in MODELS.items():
        # 80x80 input gives a 5x5 final feature map: ((80 + 15) // 16).
        model = getattr(module, arch)(conv6_kernel=(5, 5))
        state = torch.load(
            repo / "resources" / "anti_spoof_models" / weights_name,
            map_location="cpu",
            weights_only=True,
        )
        state = OrderedDict((k.removeprefix("module."), v) for k, v in state.items())
        model.load_state_dict(state)
        model.eval()
        dummy = torch.zeros(1, 3, 80, 80)
        torch.onnx.export(
            model,
            dummy,
            out_dir / onnx_name,
            input_names=["input"],
            output_names=["logits"],
            dynamic_axes={"input": {0: "batch"}, "logits": {0: "batch"}},
            opset_version=17,
            dynamo=False,
        )
        print("wrote", out_dir / onnx_name)


if __name__ == "__main__":
    main(Path(sys.argv[1]), Path(sys.argv[2]))
