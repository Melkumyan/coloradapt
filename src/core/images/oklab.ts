/**
 * Fast sRGB-byte -> OKLab conversion for pixel loops (a lookup table for the transfer curve, no
 * per-pixel library call). The per-color code elsewhere uses `culori`; this exists because an
 * analysis surface holds up to 262k pixels. Same matrices (Ottosson), so distances agree with
 * `calculatePerceptualDistance` to well under the thresholds used here.
 */
const LINEAR = new Float64Array(256).map((_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

export type Lab = readonly [number, number, number];

/** OKLab of an 8-bit sRGB color. */
export function rgbBytesToOklab(r: number, g: number, b: number): [number, number, number] {
  const lr = LINEAR[r]!;
  const lg = LINEAR[g]!;
  const lb = LINEAR[b]!;
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function labDistance(a: Lab, b: Lab): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function labChroma(lab: Lab): number {
  return Math.hypot(lab[1], lab[2]);
}
