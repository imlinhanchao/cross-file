#!/usr/bin/env node
// Builds self-contained screen HTML from design/src/screens/*.html:
//   {{ICON:name}} → inline Lucide SVG
//   {{QR}}        → inline room QR SVG
// Usage: node design/tools/build.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src", "screens");
const OUT = path.join(ROOT, "screens");
const ICONS = path.join(ROOT, "assets", "icons");

const qrSvg = fs.readFileSync(path.join(ROOT, "assets", "qr-room.svg"), "utf8").trim();

function icon(name) {
  const file = path.join(ICONS, `${name}.svg`);
  let svg = fs.readFileSync(file, "utf8");
  svg = svg.replace(/<!--[\s\S]*?-->/g, "").trim();
  svg = svg.replace(/\s*width="24"/, "").replace(/\s*height="24"/, "");
  svg = svg.replace(/\s*class="[^"]*"/, "");
  svg = svg.replace("<svg", '<svg class="icon"');
  return svg;
}

fs.mkdirSync(OUT, { recursive: true });

let count = 0;
for (const file of fs.readdirSync(SRC).filter((f) => f.endsWith(".html"))) {
  let html = fs.readFileSync(path.join(SRC, file), "utf8");

  html = html.replace(/\{\{ICON:([a-z0-9-]+)\}\}/g, (_, name) => icon(name));
  html = html.replace(/\{\{QR\}\}/g, qrSvg);

  const leftovers = html.match(/\{\{[^}]+\}\}/g);
  if (leftovers) throw new Error(`${file}: unresolved placeholders ${leftovers.join(", ")}`);

  fs.writeFileSync(path.join(OUT, file), html);
  count++;
}
console.log(`built ${count} screen(s) → design/screens/`);
