import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { displayScale, clampOffset, sourceRect } from "../lib/avatar-crop.js";

const VIEWPORT = 256;     // on-screen crop square (CSS px)
const OUT = 256;          // exported avatar size (px)
const MAX_ZOOM = 4;

/**
 * Modal cropper: shows the picked image in a 256px square, drag to pan,
 * scroll / pinch to zoom (zoom ≥ 1 so the square is always covered). On
 * confirm it draws the cropped region to a 256×256 canvas and exports webp
 * (jpeg fallback where webp export is unsupported), handing the data URL to
 * `onConfirm`.
 */
export function AvatarCropper({ file, onConfirm, onCancel }: {
  file: File;
  onConfirm: (dataUrl: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);

  // Load the picked file into an Image, recentre when it (or zoom) changes.
  useEffect(() => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => setImg(im);
    im.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    if (!img) return;
    const scale = displayScale(img.naturalWidth, img.naturalHeight, VIEWPORT, zoom);
    // Centre the image in the viewport.
    const cx = (VIEWPORT - img.naturalWidth * scale) / 2;
    const cy = (VIEWPORT - img.naturalHeight * scale) / 2;
    setOffset({
      x: clampOffset(cx, img.naturalWidth, img.naturalHeight, VIEWPORT, scale),
      y: clampOffset(cy, img.naturalHeight, img.naturalWidth, VIEWPORT, scale),
    });
  }, [img, zoom]);

  if (!img) return null;
  const scale = displayScale(img.naturalWidth, img.naturalHeight, VIEWPORT, zoom);
  const dispW = img.naturalWidth * scale;
  const dispH = img.naturalHeight * scale;

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { px: e.clientX, py: e.clientY, ox: offset.x, oy: offset.y };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const nx = drag.current.ox + (e.clientX - drag.current.px);
    const ny = drag.current.oy + (e.clientY - drag.current.py);
    setOffset({
      x: clampOffset(nx, img.naturalWidth, img.naturalHeight, VIEWPORT, scale),
      y: clampOffset(ny, img.naturalHeight, img.naturalWidth, VIEWPORT, scale),
    });
  };
  const onPointerUp = () => { drag.current = null; };

  const confirm = () => {
    const canvas = document.createElement("canvas");
    canvas.width = OUT; canvas.height = OUT;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const r = sourceRect(img.naturalWidth, img.naturalHeight, VIEWPORT, scale, offset.x, offset.y);
    ctx.drawImage(img, r.sx, r.sy, r.sw, r.sh, 0, 0, OUT, OUT);
    let url = canvas.toDataURL("image/webp", 0.85);
    if (!url.startsWith("data:image/webp")) url = canvas.toDataURL("image/jpeg", 0.85);
    onConfirm(url);
  };

  return (
    <div className="cropper__backdrop" role="dialog" aria-modal="true">
      <div className="cropper">
        <div className="cropper__title">{t("settings.account.cropTitle")}</div>
        <div
          className="cropper__viewport"
          style={{ width: VIEWPORT, height: VIEWPORT }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={(e) => {
            const next = Math.min(MAX_ZOOM, Math.max(1, zoom - e.deltaY * 0.001));
            setZoom(next);
          }}
        >
          <img
            className="cropper__img"
            src={img.src}
            draggable={false}
            style={{ width: dispW, height: dispH, transform: `translate(${offset.x}px, ${offset.y}px)` }}
            alt=""
          />
          <div className="cropper__ring" />
        </div>
        <input
          className="cropper__zoom"
          type="range" min={1} max={MAX_ZOOM} step={0.01}
          value={zoom}
          onChange={(e) => setZoom(Number(e.target.value))}
          aria-label={t("settings.account.cropZoom")}
        />
        <div className="cropper__actions">
          <button className="btn btn-sm btn-ghost" onClick={onCancel}>{t("settings.account.cropCancel")}</button>
          <button className="btn btn-sm" onClick={confirm}>{t("settings.account.cropSave")}</button>
        </div>
      </div>
    </div>
  );
}
