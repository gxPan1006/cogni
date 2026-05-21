/**
 * Pure crop-math for the avatar cropper. No DOM/canvas here so it's unit
 * testable; AvatarCropper.tsx feeds these results into a canvas drawImage.
 *
 * Coordinate model: a square `viewport` (CSS px). The source image is drawn at
 * `displayScale` screen px per source px, with its top-left at (offsetX,
 * offsetY) screen px relative to the viewport's top-left. At zoom 1 the image
 * exactly covers the viewport along its shorter side; zoom > 1 magnifies.
 */

/** Screen px per source px so the image covers the viewport along its shorter side, times zoom. */
export function displayScale(natW: number, natH: number, viewport: number, zoom: number): number {
  return (viewport / Math.min(natW, natH)) * zoom;
}

/**
 * Clamp one offset axis so the (scaled) image always fully covers the viewport.
 * `coord` is the proposed offset (≤ 0); `dispLen = natLen * scale`. Returns the
 * offset clamped to [viewport - dispLen, 0] (or 0 if the image is smaller).
 */
export function clampOffset(coord: number, natW: number, natH: number, viewport: number, scale: number): number {
  // natW/natH passed for symmetry with sourceRect callers; per-axis length is
  // chosen by the caller via which dimension it maps. Here we treat natW as the
  // axis length being clamped.
  void natH;
  const dispLen = natW * scale;
  const min = Math.min(0, viewport - dispLen);
  if (coord > 0) return 0;
  if (coord < min) return min;
  return coord;
}

/** Map the square viewport back to a source-pixel rectangle for ctx.drawImage. */
export function sourceRect(
  natW: number, natH: number, viewport: number, scale: number, offsetX: number, offsetY: number,
): { sx: number; sy: number; sw: number; sh: number } {
  void natW; void natH;
  const span = viewport / scale;
  // `+ 0` normalises -0 (from `-0 / scale`) to 0 so callers/tests get a plain 0.
  return { sx: -offsetX / scale + 0, sy: -offsetY / scale + 0, sw: span, sh: span };
}
