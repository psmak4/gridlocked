/** WCAG 2.1 contrast helpers for `#rrggbb` colors. */

function parseHex(hex: string): [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match?.[1]) throw new Error(`Invalid hex color: ${hex}`);
  const n = parseInt(match[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colors, from 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * Mixes `fg` over `bg`: `amount` of fg and `1 - amount` of bg, per channel,
 * rounded. Returns lowercase `#rrggbb`.
 */
export function mixHex(fg: string, bg: string, amount: number): string {
  const f = parseHex(fg);
  const b = parseHex(bg);
  const channels = f.map((c, i) =>
    Math.round(c * amount + (b[i] as number) * (1 - amount)),
  );
  return `#${channels.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}
