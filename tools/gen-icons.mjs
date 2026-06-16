#!/usr/bin/env node
/**
 * Generates the PNG icons the manifest references. Stream Deck wants PNG for the
 * plugin/category/action icons, so we draw a small gauge into an RGBA buffer and
 * hand-roll a PNG encoder (no native deps). The live key image is SVG and is drawn
 * at runtime by lib/render.js instead.
 */
import zlib from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "com.mrjefftang.claude-usage.sdPlugin");

// --- PNG encoder ------------------------------------------------------------
const CRC_TABLE = (() => {
	const t = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c;
	}
	return t;
})();
function crc32(buf) {
	let c = ~0;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return ~c >>> 0;
}
function chunk(type, data) {
	const typeBuf = Buffer.from(type, "ascii");
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length, 0);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
	return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePng(width, height, rgba) {
	const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // color type RGBA
	const stride = width * 4;
	const raw = Buffer.alloc((stride + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (stride + 1)] = 0; // filter: none
		rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
	}
	return Buffer.concat([
		sig,
		chunk("IHDR", ihdr),
		chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

// --- tiny drawing helpers ---------------------------------------------------
function hexToRgb(hex) {
	return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}
function blend(buf, i, [r, g, b], a) {
	buf[i] = Math.round(buf[i] * (1 - a) + r * a);
	buf[i + 1] = Math.round(buf[i + 1] * (1 - a) + g * a);
	buf[i + 2] = Math.round(buf[i + 2] * (1 - a) + b * a);
	buf[i + 3] = Math.max(buf[i + 3], Math.round(255 * a));
}

/** Draw a rounded-square gauge icon (track + ~68% colored arc) at the given size. */
function drawIcon(size) {
	const buf = Buffer.alloc(size * size * 4); // transparent
	const bg = hexToRgb("#17181c");
	const track = hexToRgb("#2c2f36");
	const accent = hexToRgb("#cc785c");
	const radius = size * 0.36;
	const cx = size / 2;
	const cy = size / 2;
	const ringW = Math.max(2, size * 0.13);
	const corner = size * 0.22;

	// gauge geometry: 270° arc starting at 135°, 68% filled
	const startA = 135;
	const sweep = 270;
	const fill = 0.68;

	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const i = (y * size + x) * 4;
			// rounded-rect background
			const rx = Math.max(corner - x, x - (size - corner), 0);
			const ry = Math.max(corner - y, y - (size - corner), 0);
			const inCorner = rx > 0 && ry > 0;
			const cornerDist = Math.hypot(rx, ry);
			if (!inCorner || cornerDist <= corner) {
				const edge = inCorner ? Math.min(1, corner - cornerDist + 0.5) : 1;
				blend(buf, i, bg, Math.min(1, edge));
			}
			// ring
			const dx = x + 0.5 - cx;
			const dy = y + 0.5 - cy;
			const dist = Math.hypot(dx, dy);
			const band = Math.abs(dist - radius);
			if (band <= ringW / 2 + 0.5) {
				let deg = (Math.atan2(dy, dx) * 180) / Math.PI; // -180..180, 0 = +x
				let rel = deg - startA;
				while (rel < 0) rel += 360;
				const aa = Math.min(1, ringW / 2 + 0.5 - band);
				if (rel <= sweep) {
					const isFilled = rel <= sweep * fill;
					blend(buf, i, isFilled ? accent : track, aa);
				}
			}
		}
	}
	return buf;
}

function write(path, size) {
	const full = resolve(ROOT, path);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, encodePng(size, size, drawIcon(size)));
	console.log(`wrote ${path} (${size}x${size})`);
}

// Sizes per Stream Deck conventions (@1x + @2x).
write("imgs/plugin/icon.png", 28);
write("imgs/plugin/icon@2x.png", 56);
write("imgs/plugin/category.png", 28);
write("imgs/plugin/category@2x.png", 56);
write("imgs/actions/usage/icon.png", 20);
write("imgs/actions/usage/icon@2x.png", 40);
write("imgs/actions/usage/key.png", 72);
write("imgs/actions/usage/key@2x.png", 144);
write("imgs/plugin/marketplace.png", 256);
console.log("done");
