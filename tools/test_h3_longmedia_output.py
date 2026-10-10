"""CPU regression checks for the installed LongMedia output-layer patch."""

import ast
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
import unittest

import torch
from torch import nn


ROOT = Path(__file__).resolve().parents[1]


def load_definitions(path, names, namespace):
    tree = ast.parse(path.read_text(encoding="utf-8-sig"))
    definitions = [node for node in tree.body if getattr(node, "name", None) in names]
    if len(definitions) != len(names):
        raise AssertionError(f"Missing definitions in {path}")
    exec(compile(ast.Module(body=definitions, type_ignores=[]), str(path), "exec"), namespace)


@contextmanager
def cpu_weights(head, *_args, **_kwargs):
    yield head.weight, head.bias


def report(_state, _stage, reference, candidate, **_kwargs):
    torch.testing.assert_close(reference, candidate, rtol=1e-5, atol=1e-6)


NAMESPACE = {
    "torch": torch,
    "nn": nn,
    "comfy": SimpleNamespace(ops=SimpleNamespace(CastBiasWeightContext=cpu_weights)),
    "_lm_print": lambda *_args, **_kwargs: None,
    "_v24_probe_local_offsets": lambda n: [0, n - 1] if n else [],
    "_v24_final_report": report,
}
load_definitions(ROOT / "ComfyUI/comfy/ldm/minimax/model.py",
                 {"FinalLayer", "_mod_row", "_pdd_head", "time_shift_sigma"}, NAMESPACE)
load_definitions(ROOT / "ComfyUI/custom_nodes/ComfyUI-MiniMax-H3-LongMedia/nodes.py",
                 {"_install_h3_final_output_streaming"}, NAMESPACE)


class OutputStreamingTests(unittest.TestCase):
    def setUp(self):
        torch.manual_seed(12)
        self.layer = NAMESPACE["FinalLayer"].__new__(NAMESPACE["FinalLayer"])
        nn.Module.__init__(self.layer)
        self.norm_sizes = []

        class Norm(nn.Module):
            def forward(norm, x):
                self.norm_sizes.append(len(x))
                return torch.nn.functional.rms_norm(x, (4,))

        self.layer.norm = Norm()
        self.layer.adaln_proj = lambda t: (t * 0.1, t * 0.2)
        self.layer.video_out = nn.Linear(4, 6)
        self.layer.audio_out = nn.Linear(4, 3)
        self.x = torch.randn(1100, 4)
        self.t = torch.randn(3, 4)
        self.state = {}
        self.patcher = SimpleNamespace(model=SimpleNamespace(diffusion_model=SimpleNamespace(final_layer=self.layer)))

    def install(self):
        self.assertTrue(NAMESPACE["_install_h3_final_output_streaming"](self.patcher, self.state, chunk_tokens=256))

    def check_output(self, args):
        expected = self.layer(*args)
        self.norm_sizes.clear()
        self.install()
        actual = self.layer(*args)
        for reference, candidate in zip(expected, actual):
            torch.testing.assert_close(reference, candidate, rtol=1e-5, atol=1e-6)

    def test_current_comfy_signature_keeps_chunked_output(self):
        self.check_output((self.x, self.t, (0, 700, 1), (700, 1100, 2),
                           torch.tensor(1.0), None, (12.0, 3.0)))
        self.assertLessEqual(max(self.norm_sizes), 256)
        self.assertEqual(self.state["final_output_streaming_calls"], 2)

    def test_legacy_signature(self):
        args = (self.x, self.t, (0, 700, 1), (700, 1100, 2))
        expected = self.layer(*args, torch.tensor(1.0), None, (12.0, 3.0))
        self.install()
        for reference, candidate in zip(expected, self.layer(*args)):
            torch.testing.assert_close(reference, candidate, rtol=1e-5, atol=1e-6)

    def test_per_token_modulation_rows(self):
        self.check_output((self.x, self.t, (0, 700, torch.arange(700) % 3),
                           (700, 1100, torch.arange(400) % 3), torch.tensor(1.0), None, (12.0, 3.0)))
        self.assertLessEqual(max(self.norm_sizes), 256)

    def test_pdd_heads_preserve_scheduler_math(self):
        self.layer.video_out.weight = nn.Parameter(torch.randn(24, 4))
        self.layer.video_out.bias = nn.Parameter(torch.randn(24))
        self.layer.audio_out.weight = nn.Parameter(torch.randn(12, 4))
        self.layer.audio_out.bias = nn.Parameter(torch.randn(12))
        self.check_output((self.x, self.t, (0, 700, 1), (700, 1100, 2),
                           torch.tensor(0.7), torch.tensor([1.0, 0.7, 0.2, 0.0]), (12.0, 3.0)))

    def test_pdd_without_schedule_keeps_original_error(self):
        self.layer.video_out.weight = nn.Parameter(torch.randn(24, 4))
        self.install()
        with self.assertRaisesRegex(ValueError, "sigma schedule"):
            self.layer(self.x, self.t, (0, 700, 1), (700, 1100, 2), torch.tensor(1.0), None, (12.0, 3.0))

    def test_reinstall_preserves_original_forward(self):
        original = self.layer.forward
        self.install()
        self.install()
        self.assertEqual(self.layer._latentlab_final_output_original_forward, original)
        NAMESPACE["_LONGMEDIA_HOT_RELOAD_BYPASS"] = True
        try:
            self.install()
        finally:
            NAMESPACE.pop("_LONGMEDIA_HOT_RELOAD_BYPASS")
        self.assertEqual(self.layer._latentlab_final_output_original_forward, original)
        self.layer(self.x, self.t, (0, 700, 1), (700, 1100, 2), torch.tensor(1.0), None, (12.0, 3.0))


if __name__ == "__main__":
    unittest.main()
