"""Validate camera settings saved alongside Qwen works without loading the GPU."""
import ast
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1] / "integrations/ComfyUI-H3-Studio/h3_studio_api.py"
tree = ast.parse(SOURCE.read_text(encoding="utf-8-sig"))
namespace = {"Path": Path}
exec(compile(ast.Module(body=[node for node in tree.body if getattr(node, "name", None) == "validated_metadata"], type_ignores=[]), str(SOURCE), "exec"), namespace)


class QwenCameraMetadataTests(unittest.TestCase):
    def test_camera_roundtrip_and_invalid_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "original.png").write_bytes(b"fixture")
            namespace["folder_paths"] = SimpleNamespace(get_input_directory=lambda: directory)
            namespace["resolve_input_image"] = lambda name: root / name
            camera = {"azimuth": 90, "elevation": 60, "framing": "close-up", "strength": 0.65}
            data = {"model": "qwen-image-2.1", "referenceFiles": ["original.png"], "qwenCamera": camera, "prompt": "<mva> right side view, high-angle shot close-up"}
            metadata = namespace["validated_metadata"](data)
            self.assertEqual(metadata["qwenCamera"], camera)
            self.assertEqual(metadata["referenceFiles"], ["original.png"])
            self.assertEqual(metadata["prompt"], data["prompt"])
            for strength in (0, 0.8, 1):
                result = namespace["validated_metadata"]({**data, "qwenCamera": {**camera, "strength": strength}})
                self.assertEqual(result["qwenCamera"]["strength"], strength)
            legacy = {key: value for key, value in camera.items() if key != "strength"}
            self.assertEqual(namespace["validated_metadata"]({**data, "qwenCamera": legacy})["qwenCamera"]["strength"], 1)
            for strength in (-0.1, 1.1, True, "0.8", float("nan"), float("inf")):
                with self.subTest(strength=strength), self.assertRaises(ValueError):
                    namespace["validated_metadata"]({**data, "qwenCamera": {**camera, "strength": strength}})
            for invalid in [{**camera, "azimuth": 47}, {**camera, "azimuth": False}, {**camera, "elevation": -30}, {**camera, "framing": "wide"}, "invalid"]:
                with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                    namespace["validated_metadata"]({**data, "qwenCamera": invalid})
            for images in [[], ["original.png", "original.png"]]:
                with self.assertRaises(ValueError):
                    namespace["validated_metadata"]({**data, "referenceFiles": images})
            ordinary = namespace["validated_metadata"]({key: value for key, value in data.items() if key != "qwenCamera"})
            self.assertNotIn("qwenCamera", ordinary)


if __name__ == "__main__":
    unittest.main()
