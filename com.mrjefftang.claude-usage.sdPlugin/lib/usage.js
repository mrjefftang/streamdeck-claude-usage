"use strict";

/**
 * Fetches the Claude usage/limits snapshot from the OAuth usage endpoint.
 *
 * GET https://api.anthropic.com/api/oauth/usage
 *   Authorization: Bearer <oauth access token>
 *   anthropic-beta: oauth-2025-04-20
 *   User-Agent:     claude-code/<version>   (required — the bare bucket is rate limited hard)
 *
 * Response shape (fields may be null when a window doesn't apply):
 *   {
 *     "five_hour":        { "utilization": 33.0, "resets_at": "2026-..." },
 *     "seven_day":        { "utilization": 13.0, "resets_at": "2026-..." },
 *     "seven_day_opus":   null,
 *     "seven_day_sonnet": { "utilization": 1.0,  "resets_at": "2026-..." },
 *     "extra_usage":      { "is_enabled": false, ... }
 *   }
 */

const https = require("node:https");

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const USER_AGENT = "claude-code/1.0.0 (streamdeck-claude-usage)";
const ANTHROPIC_BETA = "oauth-2025-04-20";

function getJson(urlString, accessToken) {
	return new Promise((resolve, reject) => {
		const url = new URL(urlString);
		const req = https.request(
			{
				method: "GET",
				hostname: url.hostname,
				path: url.pathname + url.search,
				headers: {
					Authorization: `Bearer ${accessToken}`,
					"anthropic-beta": ANTHROPIC_BETA,
					"User-Agent": USER_AGENT,
					Accept: "application/json",
				},
			},
			(res) => {
				let data = "";
				res.on("data", (c) => (data += c));
				res.on("end", () => {
					let json = null;
					try {
						json = data ? JSON.parse(data) : null;
					} catch {
						/* leave json null */
					}
					resolve({ status: res.statusCode, json, raw: data });
				});
			}
		);
		req.on("error", reject);
		req.end();
	});
}

/**
 * @returns {Promise<{status:number, data:object|null, retryAfter:number|null, raw:string}>}
 */
async function fetchUsage(accessToken) {
	const res = await getJson(USAGE_URL, accessToken);
	return {
		status: res.status,
		data: res.json,
		raw: res.raw,
	};
}

/**
 * Normalize one window ("five_hour", "seven_day", ...) into the shape the renderer wants.
 * Returns null when the window isn't present.
 */
function pickWindow(data, key) {
	if (!data || !data[key] || typeof data[key].utilization !== "number") return null;
	const w = data[key];
	return {
		utilization: Math.max(0, Math.min(100, w.utilization)),
		resetsAt: w.resets_at || null,
	};
}

module.exports = { fetchUsage, pickWindow, USAGE_URL };
