import { GeneratedVideo, request, waitForResult } from "./comfy";

export type EnhancementInput = {
  sourceId: string;
  inputFile: string;
  sourceName: string;
  width: number;
  height: number;
  duration: number;
  outputWidth: number;
  outputHeight: number;
};

export function buildEnhancementWorkflow(source: EnhancementInput) {
  const node = (class_type: string, inputs: Record<string, unknown>) => ({ class_type, inputs });
  return {
    "1": node("LoadVideo", { file: source.inputFile }),
    "2": node("GetVideoComponents", { video: ["1", 0] }),
    "3": node("ResizeImageMaskNode", { input: ["2", 0], resize_type: "scale dimensions", "resize_type.width": source.outputWidth, "resize_type.height": source.outputHeight, "resize_type.crop": "disabled", scale_method: "lanczos" }),
    "4": node("SeedVR2Preprocess", { resized_images: ["3", 0] }),
    "5": node("VAELoader", { vae_name: "seedvr2_ema_vae_fp16.safetensors" }),
    "6": node("UNETLoader", { unet_name: "seedvr2_3b_int8_convrot.safetensors", weight_dtype: "default" }),
    "7": node("VAEEncodeTiled", { pixels: ["4", 0], vae: ["5", 0], tile_size: 512, overlap: 128, temporal_size: 16, temporal_overlap: 8 }),
    "8": node("SeedVR2TemporalChunk", { latent: ["7", 0], temporal_overlap: 1, chunking_mode: "manual", "chunking_mode.frames_per_chunk": 9 }),
    "9": node("SeedVR2Conditioning", { model: ["6", 0], vae_conditioning: ["8", 0] }),
    "10": node("KSampler", { model: ["6", 0], seed: 42, steps: 1, cfg: 1, sampler_name: "euler", scheduler: "simple", positive: ["9", 0], negative: ["9", 1], latent_image: ["8", 0], denoise: 1 }),
    "11": node("SeedVR2TemporalMerge", { latents: ["10", 0], temporal_overlap: ["8", 1] }),
    "12": node("VAEDecodeTiled", { samples: ["11", 0], vae: ["5", 0], tile_size: 512, overlap: 128, temporal_size: 16, temporal_overlap: 8 }),
    "13": node("SeedVR2PostProcessing", { images: ["12", 0], original_resized_images: ["3", 0], color_correction_method: "lab" }),
    "14": node("CreateVideo", { images: ["13", 0], fps: ["2", 2], bit_depth: 8 }),
    "15": node("SaveVideo", { video: ["14", 0], filename_prefix: `h3_enhance_cache/${source.sourceId}`, format: "mp4", "format.codec": "h264" }),
  };
}

export async function prepareEnhancement(source: File | GeneratedVideo, start: number, duration: number) {
  let init: RequestInit;
  if (source instanceof File) {
    const body = new FormData();
    body.append("video", source);
    body.append("sourceName", source.name);
    body.append("start", String(start));
    body.append("duration", String(duration));
    init = { method: "POST", body };
  } else {
    init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source, start, duration }) };
  }
  return await (await request("/h3-studio/enhance/prepare", init)).json() as EnhancementInput;
}

export async function runEnhancement(source: EnhancementInput, onStatus: (message: string) => void) {
  onStatus("SeedVR2 正在載入模型與提升畫質…");
  const result = await (await request("/prompt", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: buildEnhancementWorkflow(source), client_id: crypto.randomUUID() }),
  })).json() as { prompt_id?: string; error?: { message?: string }; node_errors?: unknown };
  if (!result.prompt_id) throw new Error(`SeedVR2 工作流無法執行：${result.error?.message ?? JSON.stringify(result.node_errors)}`);
  return waitForResult(result.prompt_id, () => onStatus("SeedVR2 正在提升畫質與 LAB 校色…"));
}

export async function blendEnhancement(source: EnhancementInput, raw: GeneratedVideo | null, strength: number) {
  return await (await request("/h3-studio/enhance/blend", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourceId: source.sourceId, raw, strength }),
  })).json() as GeneratedVideo;
}
