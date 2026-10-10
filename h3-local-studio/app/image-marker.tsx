"use client";

import { PointerEvent, useEffect, useRef, useState } from "react";

type Point = { x: number; y: number };
type Stroke = { color: string; width: number; points: Point[] };
const COLORS = [
  { name: "藍", value: "#0066ff" },
  { name: "紅", value: "#ff0000" },
  { name: "綠", value: "#00b83f" },
  { name: "洋紅", value: "#ff00ff" },
];

export function ImageMarker({ file, onCancel, onApply }: {
  file: File;
  onCancel: () => void;
  onApply: (file: File) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const imageRef = useRef<ImageBitmap | null>(null);
  const activeStroke = useRef<Stroke | null>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [color, setColor] = useState(COLORS[0].value);
  const [width, setWidth] = useState(6);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && !saving) onCancel();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onCancel, saving]);

  useEffect(() => {
    let cancelled = false;
    void createImageBitmap(file).then((bitmap) => {
      if (cancelled) { bitmap.close(); return; }
      imageRef.current = bitmap;
      const canvas = canvasRef.current!;
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
      setReady(true);
    }).catch(() => { if (!cancelled) setError("無法讀取圖片。 "); });
    return () => { cancelled = true; imageRef.current?.close(); imageRef.current = null; };
  }, [file]);

  function draw(lines: Stroke[]) {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context || !imageRef.current) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(imageRef.current, 0, 0);
    for (const stroke of lines) {
      context.strokeStyle = stroke.color;
      context.fillStyle = stroke.color;
      context.lineWidth = stroke.width;
      context.lineCap = "round";
      context.lineJoin = "round";
      context.beginPath();
      const first = stroke.points[0];
      if (stroke.points.length === 1) {
        context.arc(first.x, first.y, stroke.width / 2, 0, Math.PI * 2);
        context.fill();
      } else {
        context.moveTo(first.x, first.y);
        for (const point of stroke.points.slice(1)) context.lineTo(point.x, point.y);
        context.stroke();
      }
    }
  }

  function pointFor(event: PointerEvent<HTMLCanvasElement>): Point {
    const canvas = event.currentTarget;
    const bounds = canvas.getBoundingClientRect();
    return { x: (event.clientX - bounds.left) * canvas.width / bounds.width, y: (event.clientY - bounds.top) * canvas.height / bounds.height };
  }

  function finishStroke(event: PointerEvent<HTMLCanvasElement>) {
    if (!event.isPrimary || !activeStroke.current) return;
    const next = [...strokes, activeStroke.current];
    activeStroke.current = null;
    setStrokes(next);
    draw(next);
  }

  async function apply() {
    setSaving(true);
    try {
      const blob = await new Promise<Blob | null>((resolve) => canvasRef.current!.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("Canvas produced no image");
      onApply(new File([blob], `${file.name.replace(/\.[^.]+$/, "")}-marked.png`, { type: "image/png" }));
    } catch {
      setError("無法套用記號，請再試一次。 ");
      setSaving(false);
    }
  }

  return (
    <div className="crop-modal" role="dialog" aria-modal="true" aria-label="圖片畫記號">
      <div className="crop-modal-panel">
        <header><h3>圖片畫記號</h3><p>在圖片上拖曳畫線，或點一下做記號。套用後會連同圖片送給模型。</p></header>
        <div className="marker-toolbar">
          {COLORS.map((item) => (
            <button key={item.value} type="button" aria-pressed={color === item.value} disabled={saving} onClick={() => setColor(item.value)}>
              <span style={{ background: item.value }} />{item.name}
            </button>
          ))}
          <label>筆粗 <input aria-label="筆粗" type="range" min="2" max="20" value={width} disabled={saving} onChange={(event) => setWidth(Number(event.target.value))} />{width}</label>
          <button type="button" disabled={!strokes.length || saving} onClick={() => { const next = strokes.slice(0, -1); setStrokes(next); draw(next); }}>復原上一筆</button>
          <button type="button" disabled={!strokes.length || saving} onClick={() => { setStrokes([]); draw([]); }}>清除本次記號</button>
        </div>
        <div className="crop-modal-canvas">
          <canvas ref={canvasRef} className="marker-canvas" aria-label="畫記號區域"
            onPointerDown={(event) => {
              if (!ready || saving || !event.isPrimary || event.button !== 0 || activeStroke.current) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              activeStroke.current = { color, width: width * event.currentTarget.width / event.currentTarget.getBoundingClientRect().width, points: [pointFor(event)] };
              draw([...strokes, activeStroke.current]);
            }}
            onPointerMove={(event) => {
              if (!event.isPrimary || !activeStroke.current) return;
              activeStroke.current.points.push(pointFor(event));
              draw([...strokes, activeStroke.current]);
            }}
            onPointerUp={finishStroke} onPointerCancel={finishStroke} onLostPointerCapture={finishStroke}
          />
        </div>
        {error && <p className="notice error" role="alert">{error}</p>}
        <div className="crop-modal-actions">
          <span>{ready ? "保留目前圖片尺寸；原始檔案不會被覆寫。" : "正在讀取圖片…"}</span>
          <button type="button" ref={cancelRef} disabled={saving} onClick={onCancel}>取消</button>
          <button type="button" className="primary" disabled={!ready || !strokes.length || saving} onClick={() => void apply()}>{saving ? "套用中…" : "套用記號"}</button>
        </div>
      </div>
    </div>
  );
}
