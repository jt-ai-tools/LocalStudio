"""Prepare video inputs and blend SeedVR2 results without replacing originals."""

import asyncio
import json
import math
from pathlib import Path
import shutil
import subprocess
import uuid

from aiohttp import web
import folder_paths
from server import PromptServer

from .h3_studio_api import metadata_path_for, resolve_output_video


def run_ffmpeg(arguments):
    executable = shutil.which("ffmpeg")
    if not executable:
        raise ValueError("找不到 FFmpeg，請先安裝並加入 PATH。")
    result = subprocess.run([executable, "-hide_banner", "-loglevel", "error", *arguments],
                            capture_output=True, text=True, timeout=600)
    if result.returncode:
        raise ValueError(result.stderr.strip()[-1200:] or "影片處理失敗。")


def probe_video(path):
    executable = shutil.which("ffprobe")
    if not executable:
        raise ValueError("找不到 FFprobe，請先安裝 FFmpeg。")
    result = subprocess.run([executable, "-v", "error", "-show_streams", "-show_format",
                             "-of", "json", str(path)], capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise ValueError("無法讀取影片，請選擇有效的 MP4、MOV 或 WebM。")
    data = json.loads(result.stdout)
    video = next((s for s in data["streams"] if s["codec_type"] == "video"), None)
    if not video:
        raise ValueError("檔案沒有影片畫面。")
    width, height = video["width"], video["height"]
    # FFmpeg applies rotation when preparing the clip; use its displayed geometry.
    rotation = video.get("tags", {}).get("rotate", 0)
    for side in video.get("side_data_list", []):
        rotation = side.get("rotation", rotation)
    if round(float(rotation)) % 180:
        width, height = height, width
    return {"width": width, "height": height, "duration": float(data["format"]["duration"]),
            "sound": any(s["codec_type"] == "audio" for s in data["streams"])}


def input_paths(source_id):
    if not isinstance(source_id, str) or len(source_id) != 32 or any(c not in "0123456789abcdef" for c in source_id):
        raise ValueError("無效的影片來源。")
    root = Path(folder_paths.get_input_directory()) / "h3_enhance"
    return root / f"{source_id}.mp4", root / f"{source_id}.json"


def target_dimensions(width, height):
    if min(width, height) >= 720:
        raise ValueError("目前提供升至 720p，請選擇短邊小於 720 的影片。")
    scale = 720 / min(width, height)
    return round(width * scale / 2) * 2, round(height * scale / 2) * 2


@PromptServer.instance.routes.post("/h3-studio/enhance/prepare")
async def prepare_video(request):
    source_id = uuid.uuid4().hex
    clip, manifest = input_paths(source_id)
    clip.parent.mkdir(parents=True, exist_ok=True)
    upload = None
    try:
        if request.content_type == "multipart/form-data":
            reader = await request.multipart()
            options = {}
            async for part in reader:
                if part.name == "video":
                    if upload is not None or Path(part.filename or "").suffix.lower() not in {".mp4", ".mov", ".webm"}:
                        raise ValueError("請上傳一支 MP4、MOV 或 WebM 影片。")
                    upload = clip.with_suffix(".upload" + Path(part.filename).suffix.lower())
                    total = 0
                    with upload.open("wb") as stream:
                        while chunk := await part.read_chunk():
                            total += len(chunk)
                            if total > 1024 * 1024 * 1024:
                                raise ValueError("影片檔案上限為 1 GB。")
                            stream.write(chunk)
                else:
                    options[part.name] = await part.text()
            if upload is None:
                raise ValueError("請選擇影片。")
            source = upload
            source_name = options.get("sourceName", "上傳影片")
        else:
            options = await request.json()
            item = options.get("source", {})
            if not isinstance(item, dict):
                raise ValueError("無效的影片來源。")
            source = resolve_output_video(item.get("filename"), item.get("subfolder", ""))
            source_name = source.name
        if not source.is_file():
            raise ValueError("找不到來源影片。")
        info = await asyncio.to_thread(probe_video, source)
        start = float(options.get("start", 0))
        duration = float(options.get("duration", 0)) or info["duration"] - start
        if not all(math.isfinite(n) for n in (start, duration)) or start < 0 or duration <= 0 or start + duration > info["duration"] + 0.05:
            raise ValueError("片段時間超出影片範圍。")
        if duration > 15.1:
            raise ValueError("第一版每次最多處理 15 秒，請改用片段測試。")
        width, height = target_dimensions(info["width"], info["height"])
        if max(width, height) > 2160:
            raise ValueError("影片比例過長，720p 長邊上限為 2160。")
        await asyncio.to_thread(run_ffmpeg, ["-ss", str(start), "-i", str(source), "-t", str(duration),
            "-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264", "-crf", "16", "-preset", "fast",
            "-c:a", "aac", "-y", str(clip)])
        clip_info = await asyncio.to_thread(probe_video, clip)
        info = {**clip_info, "sourceId": source_id, "inputFile": f"h3_enhance/{clip.name}",
                "sourceName": source_name, "outputWidth": width, "outputHeight": height}
        manifest.write_text(json.dumps(info, ensure_ascii=False), encoding="utf-8")
        return web.json_response(info)
    except (ValueError, TypeError, KeyError, OSError, subprocess.SubprocessError) as error:
        clip.unlink(missing_ok=True)
        return web.json_response({"error": str(error)}, status=400)
    finally:
        if upload:
            upload.unlink(missing_ok=True)


def blend_video(source_id, raw, strength):
    clip, manifest = input_paths(source_id)
    if not clip.is_file() or not manifest.is_file():
        raise ValueError("來源快取不存在，請重新選擇影片。")
    if isinstance(strength, bool) or not isinstance(strength, (int, float)) or not math.isfinite(strength) or not 0 <= strength <= 100:
        raise ValueError("強度必須介於 0～100%。")
    info = json.loads(manifest.read_text(encoding="utf-8"))
    output = Path(folder_paths.get_output_directory()) / "video" / f"H3_Studio_Enhanced_{uuid.uuid4().hex[:12]}.mp4"
    output.parent.mkdir(parents=True, exist_ok=True)
    width, height = info["outputWidth"], info["outputHeight"]
    arguments = ["-i", str(clip)]
    resize = f"scale={width}:{height}:flags=lanczos,setsar=1"
    if strength:
        if not isinstance(raw, dict) or not isinstance(raw.get("subfolder"), str) or not isinstance(raw.get("filename"), str) or raw["subfolder"].replace("\\", "/") != "h3_enhance_cache" or not raw["filename"].startswith(source_id + "_"):
            raise ValueError("AI 成品與來源不相符。")
        ai = resolve_output_video(raw["filename"], raw["subfolder"])
        if not ai.is_file():
            raise ValueError("AI 成品快取不存在，請重新處理。")
        ai_info = probe_video(ai)
        if (ai_info["width"], ai_info["height"]) != (width, height) or abs(ai_info["duration"] - info["duration"]) > 0.1:
            raise ValueError("AI 成品的尺寸或時長與來源不符。")
        arguments += ["-i", str(ai)]
        fraction = strength / 100
        filters = f"[0:v]{resize}[original];[1:v]setsar=1[ai];[original][ai]blend=all_expr='{1-fraction}*A+{fraction}*B'[v]"
    else:
        filters = f"[0:v]{resize}[v]"
    try:
        run_ffmpeg([*arguments, "-filter_complex", filters, "-map", "[v]", "-map", "0:a?",
                    "-c:v", "libx264", "-crf", "18", "-preset", "fast", "-c:a", "copy", "-y", str(output)])
        metadata = {"kind": "video", "enhanced": True, "enhancementStrength": strength,
                    "enhancementSource": info["sourceName"], "width": width, "height": height,
                    "duration": info["duration"], "sound": info["sound"], "extendable": False}
        metadata_path_for(output).write_text(json.dumps(metadata, ensure_ascii=False), encoding="utf-8")
        return {"filename": output.name, "subfolder": "video", "type": "output",
                "modifiedAt": output.stat().st_mtime, **metadata}
    except Exception:
        output.unlink(missing_ok=True)
        raise


@PromptServer.instance.routes.post("/h3-studio/enhance/blend")
async def blend_output(request):
    try:
        data = await request.json()
        result = await asyncio.to_thread(blend_video, data.get("sourceId"), data.get("raw"), data.get("strength"))
        return web.json_response(result)
    except (ValueError, TypeError, KeyError, OSError, subprocess.SubprocessError) as error:
        return web.json_response({"error": str(error)}, status=400)
