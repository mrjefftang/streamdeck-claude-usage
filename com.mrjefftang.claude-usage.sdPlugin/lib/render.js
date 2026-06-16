"use strict";

/**
 * Renders the key image as an SVG data URI. Stream Deck accepts SVG via setImage,
 * so we can draw a crisp 270° arc gauge with live text and no rasterization.
 */

const SIZE = 144; // HD key canvas
const CX = SIZE / 2;
const CY = SIZE / 2;
const RADIUS = 52;
const STROKE = 16;
const START_ANGLE = 135; // 7:30 position
const SWEEP = 270; // leave a gap at the bottom

const COLORS = {
	bg: "#17181c",
	track: "#2c2f36",
	text: "#ffffff",
	subtle: "#8b9099",
};

/** Color the value arc by how close to the limit we are. */
function colorFor(pct) {
	if (pct >= 95) return "#f85149"; // red
	if (pct >= 80) return "#f0883e"; // orange
	if (pct >= 50) return "#d29922"; // amber
	return "#3fb950"; // green
}

function pointOnCircle(cx, cy, r, angleDeg) {
	const rad = (angleDeg * Math.PI) / 180;
	return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function describeArc(cx, cy, r, startAngle, endAngle) {
	const start = pointOnCircle(cx, cy, r, startAngle);
	const end = pointOnCircle(cx, cy, r, endAngle);
	const largeArc = endAngle - startAngle <= 180 ? 0 : 1;
	return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}

/** "2h 13m" / "47m" / "<1m" / "—" from an ISO timestamp. */
function formatReset(resetsAt) {
	if (!resetsAt) return "—";
	const ms = new Date(resetsAt).getTime() - Date.now();
	if (!Number.isFinite(ms)) return "—";
	if (ms <= 0) return "now";
	const totalMin = Math.floor(ms / 60000);
	const h = Math.floor(totalMin / 60);
	const m = totalMin % 60;
	if (h >= 24) {
		const d = Math.floor(h / 24);
		return `${d}d ${h % 24}h`;
	}
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m`;
	return "<1m";
}

function esc(s) {
	return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function toDataUri(svg) {
	return "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
}

/**
 * Render a populated gauge.
 * @param {{label:string, utilization:number, resetsAt:string|null}} opts
 */
function renderGauge({ label, utilization, resetsAt }) {
	const pct = Math.max(0, Math.min(100, Math.round(utilization)));
	const color = colorFor(pct);
	const endAngle = START_ANGLE + (SWEEP * pct) / 100;
	const track = describeArc(CX, CY, RADIUS, START_ANGLE, START_ANGLE + SWEEP);
	const value = pct > 0 ? describeArc(CX, CY, RADIUS, START_ANGLE, endAngle) : "";
	const reset = formatReset(resetsAt);

	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <rect width="${SIZE}" height="${SIZE}" rx="24" fill="${COLORS.bg}"/>
  <path d="${track}" fill="none" stroke="${COLORS.track}" stroke-width="${STROKE}" stroke-linecap="round"/>
  ${value ? `<path d="${value}" fill="none" stroke="${color}" stroke-width="${STROKE}" stroke-linecap="round"/>` : ""}
  <text x="${CX}" y="34" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="17" font-weight="700" fill="${COLORS.subtle}" letter-spacing="1">${esc(label)}</text>
  <text x="${CX}" y="${CY + 8}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="42" font-weight="700" fill="${color}">${pct}<tspan font-size="22">%</tspan></text>
  <text x="${CX}" y="${CY + 34}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="16" font-weight="500" fill="${COLORS.subtle}">used</text>
  <text x="${CX}" y="132" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="18" font-weight="600" fill="${COLORS.text}">↺ ${esc(reset)}</text>
</svg>`;
	return toDataUri(svg);
}

/** Render a neutral state (signed out / error / loading) with a short message. */
function renderMessage({ label, title, subtitle, color = COLORS.subtle }) {
	const track = describeArc(CX, CY, RADIUS, START_ANGLE, START_ANGLE + SWEEP);
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <rect width="${SIZE}" height="${SIZE}" rx="24" fill="${COLORS.bg}"/>
  <path d="${track}" fill="none" stroke="${COLORS.track}" stroke-width="${STROKE}" stroke-linecap="round"/>
  <text x="${CX}" y="34" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="17" font-weight="700" fill="${COLORS.subtle}" letter-spacing="1">${esc(label || "CLAUDE")}</text>
  <text x="${CX}" y="${CY + 6}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="22" font-weight="700" fill="${color}">${esc(title)}</text>
  ${subtitle ? `<text x="${CX}" y="${CY + 30}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="15" font-weight="500" fill="${COLORS.subtle}">${esc(subtitle)}</text>` : ""}
</svg>`;
	return toDataUri(svg);
}

/**
 * Render two horizontal bars — 5-hour on top, weekly on the bottom — each with its
 * percentage on the right, and the time to the next 5-hour reset along the bottom.
 * @param {{five:{utilization:number,resetsAt:string|null}|null, week:{utilization:number}|null}} opts
 */
function renderBars({ five, week }) {
	const MARGIN = 14;
	const PCT_W = 34; // reserved on the right for the "100%" label
	const BAR_X = MARGIN;
	const BAR_W = SIZE - MARGIN - PCT_W - MARGIN;
	const BAR_H = 18;
	const RX = BAR_H / 2;
	const PCT_X = SIZE - MARGIN;

	function bar(value, labelText, labelY, barY) {
		const has = value && typeof value.utilization === "number";
		const pct = has ? Math.round(value.utilization) : null;
		const color = has ? colorFor(pct) : COLORS.subtle;
		const fillW = has && pct > 0 ? Math.max(BAR_H, (BAR_W * pct) / 100) : 0;
		const textY = barY + BAR_H - 4;
		return `
  <text x="${BAR_X}" y="${labelY}" font-family="Helvetica, Arial, sans-serif" font-size="15" font-weight="700" fill="${COLORS.subtle}" letter-spacing="1">${esc(labelText)}</text>
  <rect x="${BAR_X}" y="${barY}" width="${BAR_W}" height="${BAR_H}" rx="${RX}" fill="${COLORS.track}"/>
  ${fillW > 0 ? `<rect x="${BAR_X}" y="${barY}" width="${fillW.toFixed(1)}" height="${BAR_H}" rx="${RX}" fill="${color}"/>` : ""}
  <text x="${PCT_X}" y="${textY}" text-anchor="end" font-family="Helvetica, Arial, sans-serif" font-size="19" font-weight="700" fill="${color}">${has ? pct + "%" : "—"}</text>`;
	}

	const reset = formatReset(five ? five.resetsAt : null);
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <rect width="${SIZE}" height="${SIZE}" rx="24" fill="${COLORS.bg}"/>${bar(five, "5H", 32, 38)}${bar(week, "7D", 84, 90)}
  <text x="${CX}" y="134" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="18" font-weight="600" fill="${COLORS.text}">↺ ${esc(reset)}</text>
</svg>`;
	return toDataUri(svg);
}

module.exports = { renderGauge, renderBars, renderMessage, formatReset };
