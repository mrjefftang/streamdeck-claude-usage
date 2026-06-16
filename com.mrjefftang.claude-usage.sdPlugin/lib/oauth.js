"use strict";

/**
 * Claude OAuth (PKCE) — the same flow Claude Code uses.
 *
 * Manual-code flow:
 *   1. Build an authorize URL with a PKCE challenge + state and open it in the browser.
 *   2. The user approves and Claude redirects to the console callback page, which displays
 *      a code formatted as "<authorizationCode>#<state>".
 *   3. The user pastes that string back; we split on "#", verify the state, and exchange
 *      the code for access/refresh tokens.
 */

const crypto = require("node:crypto");
const https = require("node:https");

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const SCOPES = "org:create_api_key user:profile user:inference";

function base64url(buf) {
	return buf
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

/** Generate a PKCE verifier/challenge pair plus an anti-CSRF state value. */
function createPkce() {
	const verifier = base64url(crypto.randomBytes(32));
	const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
	const state = base64url(crypto.randomBytes(32));
	return { verifier, challenge, state };
}

function buildAuthorizeUrl({ challenge, state }) {
	const u = new URL(AUTHORIZE_URL);
	u.searchParams.set("code", "true");
	u.searchParams.set("client_id", CLIENT_ID);
	u.searchParams.set("response_type", "code");
	u.searchParams.set("redirect_uri", REDIRECT_URI);
	u.searchParams.set("scope", SCOPES);
	u.searchParams.set("code_challenge", challenge);
	u.searchParams.set("code_challenge_method", "S256");
	u.searchParams.set("state", state);
	return u.toString();
}

/** Minimal JSON POST helper built on node:https so it works on any bundled Node runtime. */
function postJson(urlString, body) {
	return new Promise((resolve, reject) => {
		const url = new URL(urlString);
		const payload = Buffer.from(JSON.stringify(body));
		const req = https.request(
			{
				method: "POST",
				hostname: url.hostname,
				path: url.pathname + url.search,
				headers: {
					"Content-Type": "application/json",
					"Content-Length": payload.length,
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
		req.write(payload);
		req.end();
	});
}

/**
 * Parse the value the user pastes. The callback page shows "<code>#<state>".
 * Some browsers may also hand back a full redirect URL — handle both.
 */
function parsePastedCode(pasted) {
	const trimmed = String(pasted || "").trim();
	if (!trimmed) return { code: "", state: "" };
	if (trimmed.startsWith("http")) {
		try {
			const u = new URL(trimmed);
			return {
				code: u.searchParams.get("code") || "",
				state: u.searchParams.get("state") || "",
			};
		} catch {
			/* fall through */
		}
	}
	const [code, state] = trimmed.split("#");
	return { code: (code || "").trim(), state: (state || "").trim() };
}

async function exchangeCode({ code, state, verifier }) {
	const res = await postJson(TOKEN_URL, {
		grant_type: "authorization_code",
		code,
		state,
		client_id: CLIENT_ID,
		redirect_uri: REDIRECT_URI,
		code_verifier: verifier,
	});
	if (res.status !== 200 || !res.json || !res.json.access_token) {
		throw new Error(`Token exchange failed (HTTP ${res.status}): ${res.raw || "no body"}`);
	}
	return toTokens(res.json);
}

async function refreshTokens(refreshToken) {
	const res = await postJson(TOKEN_URL, {
		grant_type: "refresh_token",
		refresh_token: refreshToken,
		client_id: CLIENT_ID,
	});
	if (res.status !== 200 || !res.json || !res.json.access_token) {
		throw new Error(`Token refresh failed (HTTP ${res.status}): ${res.raw || "no body"}`);
	}
	return toTokens(res.json, refreshToken);
}

function toTokens(json, fallbackRefresh) {
	const expiresInMs = (Number(json.expires_in) || 3600) * 1000;
	return {
		accessToken: json.access_token,
		refreshToken: json.refresh_token || fallbackRefresh || null,
		// Refresh a minute early to avoid races against expiry.
		expiresAt: Date.now() + expiresInMs - 60_000,
		scope: json.scope || SCOPES,
	};
}

module.exports = {
	CLIENT_ID,
	SCOPES,
	createPkce,
	buildAuthorizeUrl,
	parsePastedCode,
	exchangeCode,
	refreshTokens,
};
