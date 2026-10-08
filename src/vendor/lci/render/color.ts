/**
 * Colour helper of the renderer: reads the colour strings of indicator results and combines alphas.
 * Formats: 'transparent', '#rgb', '#rgba', '#rrggbb', '#rrggbbaa', 'rgb(r, g, b)', 'rgba(r, g, b, a)'
 * (also the CSS 'rgb(r g b / a)' form). Any other CSS colour (named colours, hsl()...) is read through the canvas
 * colour parser of the browser.
 */

/** Colour channels: r, g, b 0..255, a (opacity) 0..1 */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

function parseHex(hex: string): Rgba | null {
  const h = hex.slice(1);
  if (!/^[0-9a-f]+$/i.test(h)) return null;
  if (h.length === 3 || h.length === 4) {
    const d = (i: number) => parseInt(h[i] + h[i], 16);
    return { r: d(0), g: d(1), b: d(2), a: h.length === 4 ? d(3) / 255 : 1 };
  }
  if (h.length === 6 || h.length === 8) {
    const d = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return { r: d(0), g: d(2), b: d(4), a: h.length === 8 ? d(6) / 255 : 1 };
  }
  return null;
}

function parseChannel(s: string, max: number): number {
  const t = s.trim();
  const v = parseFloat(t);
  if (Number.isNaN(v)) return NaN;
  return t.endsWith('%') ? (v / 100) * max : v;
}

function parseRgbFunction(s: string): Rgba | null {
  const m = s.match(/^rgba?\((.*)\)$/i);
  if (!m) return null;
  let body = m[1].trim();
  let alpha: string | undefined;
  let parts: string[];
  if (body.includes(',')) {
    parts = body.split(',');
    if (parts.length === 4) alpha = parts.pop();
  } else {
    // CSS level 4 form: rgb(r g b / a)
    const slash = body.split('/');
    body = slash[0];
    alpha = slash[1];
    parts = body.trim().split(/\s+/);
  }
  if (parts.length !== 3) return null;
  const [r, g, b] = parts.map((p) => parseChannel(p, 255));
  const a = alpha === undefined ? 1 : parseChannel(alpha, 1);
  if ([r, g, b, a].some((v) => Number.isNaN(v))) return null;
  return { r: clamp(r, 0, 255), g: clamp(g, 0, 255), b: clamp(b, 0, 255), a: clamp(a, 0, 1) };
}

let cssContext: CanvasRenderingContext2D | null | undefined;

/** Any other CSS colour through the canvas parser (browser only); null when the string is not a colour */
function parseWithCanvas(color: string): Rgba | null {
  if (cssContext === undefined) {
    cssContext = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  }
  if (!cssContext) return null;
  // an invalid colour leaves fillStyle unchanged: test with two different sentinels
  cssContext.fillStyle = '#000000';
  cssContext.fillStyle = color;
  const first = cssContext.fillStyle;
  cssContext.fillStyle = '#ffffff';
  cssContext.fillStyle = color;
  if (cssContext.fillStyle !== first) return null;
  return first.startsWith('#') ? parseHex(first) : parseRgbFunction(first);
}

/** Channels of a colour string; null for null / empty / unreadable strings */
export function parseColor(color: string | null | undefined): Rgba | null {
  if (color == null) return null;
  const c = color.trim();
  if (c === '') return null;
  if (c.toLowerCase() === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (c.startsWith('#')) return parseHex(c);
  if (/^rgba?\(/i.test(c)) return parseRgbFunction(c);
  return parseWithCanvas(c);
}

/** CSS text of channels: rgba(r, g, b, a) */
export function toCss(c: Rgba): string {
  const a = Math.round(clamp(c.a, 0, 1) * 10000) / 10000;
  return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${a})`;
}

/**
 * Colour with its opacity multiplied by `opacity` (0..1), as rgba() text. A colour that already carries an alpha
 * keeps it and gets the product. Null when the colour is missing, unreadable or fully transparent (Pine na colour:
 * nothing drawn).
 */
export function withOpacity(color: string | null | undefined, opacity = 1): string | null {
  const c = parseColor(color);
  if (!c) return null;
  const a = c.a * clamp(opacity, 0, 1);
  return a > 0 ? toCss({ ...c, a }) : null;
}

/** Gradient of one part of a gradient fill: CSS colours at the prices `top` and `bottom` */
export interface GradientPart {
  top: number;
  bottom: number;
  topColor: string;
  bottomColor: string;
}

/**
 * Gradient of one bar of Pine fill(p1, p2, top_value, bottom_value, top_color, bottom_color).
 * Pine rules: the colour changes with the price, top_color at top_value,
 * bottom_color at bottom_value, linear in between, the end colour outside the range; top_value below bottom_value
 * keeps top_color at top_value. Nothing is drawn when a value is na or top_value == bottom_value. An na (null,
 * empty, unreadable) colour is a transparent end: the gradient goes from the other colour to transparent. Null when
 * nothing is drawn (also when both colours are transparent).
 * A transparent end takes the RGB of the other end, so the result is the same with or without premultiplied alpha
 * interpolation.
 */
export function gradientPart(
  topValue: number | null | undefined,
  bottomValue: number | null | undefined,
  topColor: string | null | undefined,
  bottomColor: string | null | undefined
): GradientPart | null {
  if (topValue == null || bottomValue == null || !Number.isFinite(topValue) || !Number.isFinite(bottomValue)) {
    return null;
  }
  if (topValue === bottomValue) return null;
  let t = parseColor(topColor);
  let b = parseColor(bottomColor);
  const tOn = t != null && t.a > 0;
  const bOn = b != null && b.a > 0;
  if (!tOn && !bOn) return null;
  if (!tOn) t = { ...b!, a: 0 };
  if (!bOn) b = { ...t!, a: 0 };
  return { top: topValue, bottom: bottomValue, topColor: toCss(t!), bottomColor: toCss(b!) };
}

/** Fully transparent colour (Pine na colour): missing, empty, 'transparent', or alpha 0 (#rrggbb00, rgba(..., 0)) */
export function isTransparent(color: string | undefined | null): boolean {
  if (!color || !color.trim()) return true;
  const c = parseColor(color);
  return c != null && c.a === 0;
}
