#!/usr/bin/env node
// WCAG contrast verification for the CrossFile token set.
// Usage: node design/tools/check-contrast.mjs
// Fails (exit 1) if any required pair is below its threshold.

const D = Math.PI / 180;

function oklchToSrgb(L, C, h) {
  const a = C * Math.cos(h * D);
  const b = C * Math.sin(h * D);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;

  let r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  let g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  let bb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

  const lin = [r, g, bb].map((v) => Math.min(1, Math.max(0, v)));
  const enc = lin.map((v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
  const hex = enc
    .map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0"))
    .join("");
  const lum = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  return { hex: `#${hex}`, lum };
}

const o = (v) => {
  const [L, C, h] = v;
  return oklchToSrgb(L, C, h);
};

// ---- primitive ramp definitions (keep in sync with tokens.css) ----
const T = {
  // neutrals (hue 258)
  n0: [0.992, 0.002, 258],
  n25: [0.978, 0.003, 258],
  n50: [0.955, 0.004, 258],
  n100: [0.93, 0.006, 258],
  n200: [0.885, 0.008, 258],
  n300: [0.82, 0.01, 258],
  n400: [0.72, 0.012, 258],
  n500: [0.60, 0.012, 258],
  n600: [0.48, 0.012, 258],
  n700: [0.38, 0.01, 258],
  n800: [0.28, 0.009, 258],
  n850: [0.235, 0.008, 258],
  n900: [0.205, 0.007, 258],
  n925: [0.17, 0.006, 258],
  n950: [0.135, 0.005, 258],
  // mint (hue 168) — primary
  m300: [0.88, 0.1, 168],
  m400: [0.82, 0.13, 168],
  m500: [0.74, 0.15, 168],
  m600: [0.66, 0.15, 168],
  m700: [0.55, 0.13, 168],
  m800: [0.42, 0.1, 168],
  // amber (hue 75) — warning
  w300: [0.88, 0.12, 80],
  w400: [0.82, 0.14, 80],
  w600: [0.62, 0.14, 70],
  w700: [0.46, 0.11, 68],
  w800: [0.38, 0.09, 68],
  // red (hue 25) — danger
  r300: [0.82, 0.14, 25],
  r400: [0.72, 0.17, 25],
  r600: [0.55, 0.19, 25],
  r700: [0.47, 0.17, 25],
  r800: [0.38, 0.14, 25],
  // blue (hue 255) — info / direct path
  b300: [0.84, 0.1, 255],
  b400: [0.72, 0.14, 255],
  b500: [0.60, 0.16, 255],
  b600: [0.50, 0.18, 255],
  b700: [0.40, 0.16, 255],
};

// ---- semantic pairs: [name, fg token, bg token, required ratio, role] ----
const pairs = [
  // light theme
  ["light / body text on page", "n800", "n25", 4.5],
  ["light / body text on card", "n800", "n0", 4.5],
  ["light / secondary text on page", "n700", "n25", 4.5],
  ["light / secondary text on card", "n700", "n0", 4.5],
  ["light / muted text on page", "n600", "n25", 4.5],
  ["light / muted text on card", "n600", "n0", 4.5],
  ["light / button label on primary", "n950", "m400", 4.5],
  ["light / button label hover", "n950", "m300", 4.5],
  ["light / link (mint) on card", "m800", "n0", 4.5],
  ["light / danger text on card", "r600", "n0", 4.5],
  ["light / warning text on warning surface", "w700", "w300", 4.5],
  ["light / warning text on card", "w700", "n0", 4.5],
  ["light / input border vs page", "n500", "n25", 3.0],
  ["light / focus ring vs page", "b500", "n25", 3.0],
  // dark theme
  ["dark / body text on page", "n0", "n925", 4.5],
  ["dark / body text on card", "n0", "n900", 4.5],
  ["dark / secondary text on card", "n300", "n900", 4.5],
  ["dark / muted text on card", "n400", "n900", 4.5],
  ["dark / button label on primary", "n950", "m400", 4.5],
  ["dark / link (mint) on card", "m400", "n900", 4.5],
  ["dark / danger text on card", "r400", "n900", 4.5],
  ["dark / warning text on warning surface", "w400", "n850", 4.5],
  ["dark / warning text on card", "w400", "n900", 4.5],
  ["dark / input border vs card", "n500", "n900", 3.0],
  ["dark / focus ring vs card", "m400", "n900", 3.0],
];

let failures = 0;
const rows = pairs.map(([name, fg, bg, need]) => {
  const f = o(T[fg]), b = o(T[bg]);
  const ratio = (Math.max(f.lum, b.lum) + 0.05) / (Math.min(f.lum, b.lum) + 0.05);
  const pass = ratio >= need;
  if (!pass) failures++;
  return {
    name,
    fg: `${fg} ${f.hex}`,
    bg: `${bg} ${b.hex}`,
    ratio: ratio.toFixed(2),
    need: need.toFixed(1),
    pass: pass ? "PASS" : "FAIL",
  };
});

const pad = (s, n) => String(s).padEnd(n);
console.log(pad("pair", 44) + pad("fg", 16) + pad("bg", 16) + pad("ratio", 7) + pad("need", 6) + "result");
console.log("-".repeat(100));
for (const r of rows) {
  console.log(pad(r.name, 44) + pad(r.fg, 16) + pad(r.bg, 16) + pad(r.ratio, 7) + pad(r.need, 6) + r.pass);
}
console.log(`\n${rows.length - failures}/${rows.length} pairs pass`);
if (failures) {
  console.error(`\n${failures} contrast failure(s) — tune the tokens.`);
  process.exit(1);
}
