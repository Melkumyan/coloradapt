/**
 * A coarse, language-free name for a color, used to compare a legend swatch with a series'
 * paint without putting hex codes (which the redaction would take for tokens) into a packet.
 * Two colors with one name are "the same hue family", nothing more.
 */
export function coarseColorName(color: {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}): string {
  const { r, g, b } = color;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (l < 0.12) return 'black';
  if (l > 0.92) return 'white';
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (s < 0.18) return l < 0.4 ? 'darkgray' : 'gray';
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  if (h < 15 || h >= 345) return 'red';
  if (h < 40) return 'orange';
  if (h < 70) return 'yellow';
  if (h < 160) return 'green';
  if (h < 200) return 'cyan';
  if (h < 255) return 'blue';
  if (h < 290) return 'purple';
  return 'pink';
}
