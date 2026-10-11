import assert from "node:assert/strict";
import test from "node:test";
import { buildQwenCameraPrompt, buildQwenImageWorkflow, createQwenImage, QWEN_CAMERA_AZIMUTHS, QWEN_CAMERA_ELEVATIONS, QWEN_CAMERA_LORA } from "../lib/comfy.ts";

const options = { prompt: "Keep my original edit", aspect: "1:1", size: "1mp", steps: 25, seed: 42, cooldownSeconds: 0 };
const camera = { azimuth: 90, elevation: 60, framing: "close-up", strength: 0.65 };

test("camera selections map to the trained vocabulary, not arbitrary degree prompts", () => {
  assert.equal(buildQwenCameraPrompt(camera).split("\n")[0], "<mva> right side view, high-angle shot close-up");
  assert.match(buildQwenCameraPrompt(camera), /Preserve the original environment, background objects, room layout/);
  assert.match(buildQwenCameraPrompt(camera), /Do not isolate the subject or replace the environment/);
  for (const azimuth of QWEN_CAMERA_AZIMUTHS) {
    for (const elevation of QWEN_CAMERA_ELEVATIONS) {
      assert.equal(buildQwenCameraPrompt({ azimuth: azimuth.value, elevation: elevation.value, framing: "standard" }).split("\n")[0], `<mva> ${azimuth.prompt}, ${elevation.prompt}`);
    }
  }
  assert.throws(() => buildQwenCameraPrompt({ ...camera, azimuth: 47 }), /設定無效/);
});

test("camera LoRA precedes the scheduler, edit cache and optional EasyCache", () => {
  for (const fast of [false, true]) {
    const graph = buildQwenImageWorkflow({ ...options, camera, fast }, ["original.png"]);
    assert.equal(graph["14"].class_type, "LoraLoaderModelOnly");
    assert.equal(graph["14"].inputs.lora_name, QWEN_CAMERA_LORA);
    assert.equal(graph["14"].inputs.strength_model, 0.65);
    assert.deepEqual(graph["14"].inputs.model, ["1", 0]);
    assert.deepEqual(graph["8"].inputs.model, ["14", 0]);
    assert.deepEqual(graph["12"].inputs.model, ["14", 0]);
    assert.deepEqual(graph["9"].inputs.model, [fast ? "13" : "12", 0]);
    if (fast) assert.deepEqual(graph["13"].inputs.model, ["12", 0]);
    assert.equal(graph["4"].inputs.prompt, buildQwenCameraPrompt(camera));
    assert.equal(graph["300"].inputs.image, "original.png");
  }
  for (const images of [[], ["one.png", "two.png"]]) {
    assert.throws(() => buildQwenImageWorkflow({ ...options, camera }, images), /一張原圖/);
  }
});

test("turning camera off preserves ordinary text generation and multi-image editing", () => {
  for (const images of [[], ["one.png"], ["one.png", "two.png"]]) {
    const graph = buildQwenImageWorkflow(options, images);
    assert.equal(graph["14"], undefined);
    assert.equal(graph["4"].inputs.prompt, options.prompt);
    assert.deepEqual(graph["8"].inputs.model, ["1", 0]);
    if (images.length) assert.deepEqual(graph["12"].inputs.model, ["1", 0]);
  }
});

test("missing camera model fails before uploading an image or queuing GPU work", async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => { calls.push(String(url)); return Response.json({ LoraLoaderModelOnly: { input: { required: { lora_name: [[]] } } } }); };
  try {
    await assert.rejects(createQwenImage({ ...options, camera }, [new File(["image"], "original.png")], () => {}), /尚未安裝/);
    assert.deepEqual(calls, ["http://127.0.0.1:8188/object_info/LoraLoaderModelOnly"]);
    await assert.rejects(createQwenImage({ ...options, camera }, [], () => {}), /一張原圖/);
    assert.equal(calls.length, 1);
  } finally { globalThis.fetch = previousFetch; }
});

test("edit ratio crops only the first reference before vision and VAE encoding", () => {
  for (const size of ["1mp", "2k"]) {
    for (const editAspect of ["1:1", "16:9", "9:16", "3:2", "2:3", "4:3", "3:4"]) {
      const graph = buildQwenImageWorkflow({ ...options, size, editAspect }, ["first.png", "second.png"]);
      assert.deepEqual(graph["15"].inputs.image, ["300", 0]);
      assert.equal(graph["15"].inputs.crop, "center");
      assert.deepEqual(graph["4"].inputs["images.image_1"], ["15", 0]);
      assert.deepEqual(graph["4"].inputs["images.image_2"], ["301", 0]);
      assert.deepEqual(graph["9"].inputs.latent_image, ["4", 2]);
      const [w, h] = editAspect.split(":").map(Number);
      assert.equal(graph["15"].inputs.width / graph["15"].inputs.height, w / h);
    }
  }
  const automatic = buildQwenImageWorkflow(options, ["first.png"]);
  assert.equal(automatic["15"], undefined);
  assert.deepEqual(automatic["4"].inputs["images.image_1"], ["300", 0]);
  assert.equal(buildQwenImageWorkflow({ ...options, editAspect: "16:9" })["15"], undefined);
});

test("REDQW21 V2 checks installation before uploads and saves its selected model", async () => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  let installed = false;
  let saved;
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (path === "/object_info/UNETLoader") return Response.json({ UNETLoader: { input: { required: { unet_name: [installed ? ["REDQW21_V2_int8.safetensors"] : []] } } } });
    if (path === "/prompt") {
      const graph = JSON.parse(init.body).prompt;
      assert.equal(graph["1"].inputs.unet_name, "REDQW21_V2_int8.safetensors");
      return Response.json({ prompt_id: "redqw21-v2-test" });
    }
    if (path === "/history/redqw21-v2-test") return Response.json({ "redqw21-v2-test": { status: { completed: true }, outputs: { "11": { images: [{ filename: "redqw21-v2.png", subfolder: "H3_Image", type: "output" }] } } } });
    if (path === "/h3-studio/output-metadata") { saved = JSON.parse(init.body); return Response.json({ ok: true }); }
    throw new Error(`Unexpected request: ${path}`);
  };
  try {
    await assert.rejects(createQwenImage({ ...options, model: "redqw21-v2" }, [new File(["image"], "reference.png")], () => {}), /尚未安裝 REDQW21 V2/);
    assert.deepEqual(calls, ["/object_info/UNETLoader"]);
    installed = true;
    const [result] = await createQwenImage({ ...options, model: "redqw21-v2" }, [], () => {});
    assert.equal(result.qwenModel, "redqw21-v2");
    assert.equal(saved.qwenModel, "redqw21-v2");
  } finally { globalThis.fetch = previousFetch; }
});

test("camera generation saves reproducible settings and uses the same original for every image", async () => {
  const previousFetch = globalThis.fetch;
  const graphs = [];
  const saved = [];
  let uploads = 0;
  globalThis.fetch = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === "/object_info/LoraLoaderModelOnly") return Response.json({ LoraLoaderModelOnly: { input: { required: { lora_name: [[QWEN_CAMERA_LORA]] } } } });
    if (path === "/upload/image") { uploads += 1; return Response.json({ name: "original.png" }); }
    if (path === "/prompt") {
      graphs.push(JSON.parse(init.body).prompt);
      return Response.json({ prompt_id: `camera-${graphs.length}` });
    }
    if (path.startsWith("/history/")) {
      const id = path.split("/").pop();
      return Response.json({ [id]: { status: { completed: true }, outputs: { "11": { images: [{ filename: `${id}.png`, subfolder: "H3_Image", type: "output" }] } } } });
    }
    if (path === "/h3-studio/output-metadata") { saved.push(JSON.parse(init.body)); return Response.json({ ok: true }); }
    throw new Error(`Unexpected request: ${path}`);
  };
  try {
    const results = await createQwenImage({ ...options, model: "noct-q-v4", editAspect: "16:9", camera, count: 2 }, [new File(["image"], "original.png")], () => {});
    assert.equal(uploads, 1);
    assert.equal(results.length, 2);
    assert.deepEqual(saved.map((item) => item.seed), [42, 43]);
    for (const graph of graphs) {
      assert.equal(graph["1"].inputs.unet_name, "NoctQ_V4_int8_convrot.safetensors");
      assert.equal(graph["300"].inputs.image, "original.png");
      assert.equal(graph["4"].inputs.prompt, buildQwenCameraPrompt(camera));
    }
    for (const item of saved) {
      assert.equal(item.qwenModel, "noct-q-v4");
      assert.equal(item.qwenEditAspect, "16:9");
      assert.deepEqual(item.qwenCamera, camera);
      assert.deepEqual(item.extraLoras, [{ name: QWEN_CAMERA_LORA, strength: 0.65 }]);
      assert.equal(item.prompt, buildQwenCameraPrompt(camera));
      assert.deepEqual(item.referenceFiles, ["original.png"]);
    }
  } finally { globalThis.fetch = previousFetch; }
});

test("camera strength accepts zero and preserves the fixed strength for old works", () => {
  for (const strength of [0, 0.8, 1]) {
    const graph = buildQwenImageWorkflow({ ...options, camera: { ...camera, strength } }, ["original.png"]);
    assert.equal(graph["14"].inputs.strength_model, strength);
  }
  const legacyCamera = { azimuth: camera.azimuth, elevation: camera.elevation, framing: camera.framing };
  assert.equal(buildQwenImageWorkflow({ ...options, camera: legacyCamera }, ["original.png"])["14"].inputs.strength_model, 1);
  for (const invalid of [-0.1, 1.1, NaN, Infinity, "0.8"]) {
    assert.throws(() => buildQwenImageWorkflow({ ...options, camera: { ...camera, strength: invalid } }, ["original.png"]), /設定無效/);
  }
});
