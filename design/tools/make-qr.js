#!/usr/bin/env node
// Generates a real, scannable QR code (SVG) for the mockup screens.
// Usage: node design/tools/make-qr.js
const fs = require("node:fs");
const path = require("node:path");
const qrcode = require("../assets/qrcode.js");

const ROOM_URL = "https://crossfile.app/r/7QK2M9#k=9f2a4c6e8b1d3f5a7c9e2b4d6f8a1c3e";

const qr = qrcode(0, "M");
qr.addData(ROOM_URL);
qr.make();

// One path, currentColor so themes can recolor it.
const svg = qr.createSvgTag({ cellSize: 8, margin: 3, scalable: true });
const cleaned = svg
  .replace(/<svg /, '<svg class="qr-svg" role="img" aria-label="房间二维码，扫码加入" ')
  .replace(/ fill="[^"]*"/g, "")
  .replace(/ stroke="[^"]*"/g, "")
  .replace(/<rect[^>]*\/>/g, "");

const out = path.join(__dirname, "..", "assets", "qr-room.svg");
fs.writeFileSync(out, cleaned);
console.log(`wrote ${out} (${fs.statSync(out).size} bytes) for ${ROOM_URL}`);
