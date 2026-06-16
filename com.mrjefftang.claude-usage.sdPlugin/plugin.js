"use strict";

/**
 * Claude Usage — Stream Deck plugin entry point.
 *
 * Connects to the Stream Deck software over the WebSocket protocol, signs in to Claude
 * via OAuth (PKCE), polls the /api/oauth/usage endpoint, and renders each key as a gauge
 * showing percent used, a color-coded status, and time to reset.
 */

const WebSocket = require("ws");
const oauth = require("./lib/oauth");
const { fetchUsage, pickWindow } = require("./lib/usage");
const { renderGauge, renderMessage } = require("./lib/render");

// --- Tunables ---------------------------------------------------------------
const FETCH_INTERVAL_MS = 180_000; // endpoint is rate limited; 3 min is the safe floor
const TICK_INTERVAL_MS = 30_000; // re-render countdown from cache between fetches
const ACTION_UUID = "com.mrjefftang.claude-usage.limits";

const WINDOWS = {
	five_hour: { label: "5H" },
	seven_day: { label: "7D" },
	seven_day_opus: { label: "OPUS 7D" },
	seven_day_sonnet: { label: "SONNET 7D" },
};
const DEFAULT_WINDOW = "five_hour";

// --- Launch args from Stream Deck ------------------------------------------
function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i += 2) {
		const key = argv[i];
		if (key && key.startsWith("-")) out[key.slice(1)] = argv[i + 1];
	}
	return out;
}
const args = parseArgs(process.argv.slice(2));
const PORT = args.port;
const PLUGIN_UUID = args.pluginUUID;
const REGISTER_EVENT = args.registerEvent;

// --- Runtime state ----------------------------------------------------------
let ws = null;
let tokens = null; // { accessToken, refreshToken, expiresAt, scope }
let pendingAuth = null; // { verifier, state }
let usageData = null; // last good /usage response
let lastError = null; // string, when the last fetch failed
let fetching = false;
let fetchTimer = null;
let tickTimer = null;

/** contextId -> { window } for every visible key. */
const contexts = new Map();

// --- Stream Deck send helpers ----------------------------------------------
function sendRaw(obj) {
	if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function log(message) {
	sendRaw({ event: "logMessage", payload: { message: `[claude-usage] ${message}` } });
}
function setImage(context, image) {
	sendRaw({ event: "setImage", context, payload: { image, target: 0, state: 0 } });
}
function setTitle(context, title) {
	sendRaw({ event: "setTitle", context, payload: { title: title || "", target: 0, state: 0 } });
}
function showAlert(context) {
	sendRaw({ event: "showAlert", context });
}
function openUrl(url) {
	sendRaw({ event: "openUrl", payload: { url } });
}
function getGlobalSettings() {
	sendRaw({ event: "getGlobalSettings", context: PLUGIN_UUID });
}
function setGlobalSettings(payload) {
	sendRaw({ event: "setGlobalSettings", context: PLUGIN_UUID, payload });
}
function sendToPI(context, payload) {
	sendRaw({ event: "sendToPropertyInspector", context, action: ACTION_UUID, payload });
}

// --- Auth state persistence -------------------------------------------------
function persistTokens() {
	setGlobalSettings({ tokens });
}
function clearTokens() {
	tokens = null;
	usageData = null;
	persistTokens();
}

function isSignedIn() {
	return !!(tokens && tokens.accessToken);
}

// --- Rendering --------------------------------------------------------------
function renderContext(contextId) {
	const ctx = contexts.get(contextId);
	if (!ctx) return;
	const windowKey = WINDOWS[ctx.window] ? ctx.window : DEFAULT_WINDOW;
	const label = WINDOWS[windowKey].label;
	setTitle(contextId, ""); // we draw everything inside the SVG

	if (!isSignedIn()) {
		setImage(contextId, renderMessage({ label: "CLAUDE", title: "Sign in", subtitle: "in settings" }));
		return;
	}
	if (!usageData && lastError) {
		setImage(contextId, renderMessage({ label, title: "Error", subtitle: "tap to retry", color: "#f85149" }));
		return;
	}
	if (!usageData) {
		setImage(contextId, renderMessage({ label, title: "…", subtitle: "loading" }));
		return;
	}
	const win = pickWindow(usageData, windowKey);
	if (!win) {
		setImage(contextId, renderMessage({ label, title: "N/A", subtitle: "no data" }));
		return;
	}
	setImage(contextId, renderGauge({ label, utilization: win.utilization, resetsAt: win.resetsAt }));
}

function renderAll() {
	for (const id of contexts.keys()) renderContext(id);
}

// --- Usage polling ----------------------------------------------------------
async function ensureFreshToken() {
	if (!tokens) return false;
	if (tokens.expiresAt && Date.now() < tokens.expiresAt) return true;
	if (!tokens.refreshToken) return false;
	try {
		tokens = await oauth.refreshTokens(tokens.refreshToken);
		persistTokens();
		log("access token refreshed");
		return true;
	} catch (err) {
		log(`token refresh failed: ${err.message}`);
		return false;
	}
}

async function pollNow() {
	if (fetching) return;
	if (!isSignedIn()) {
		renderAll();
		return;
	}
	fetching = true;
	try {
		if (!(await ensureFreshToken())) {
			lastError = "auth";
			clearTokens();
			renderAll();
			notifyStatusToAll();
			return;
		}

		let res = await fetchUsage(tokens.accessToken);

		// Access token may have been revoked/expired server-side — refresh once and retry.
		if (res.status === 401 && tokens.refreshToken) {
			try {
				tokens = await oauth.refreshTokens(tokens.refreshToken);
				persistTokens();
				res = await fetchUsage(tokens.accessToken);
			} catch (err) {
				log(`refresh after 401 failed: ${err.message}`);
			}
		}

		if (res.status === 200 && res.data) {
			usageData = res.data;
			lastError = null;
		} else if (res.status === 429) {
			// Rate limited — keep showing the last good data rather than flashing an error.
			lastError = usageData ? null : "rate-limited";
			log("usage fetch rate limited (429)");
		} else if (res.status === 401) {
			lastError = "auth";
			clearTokens();
			notifyStatusToAll();
		} else {
			lastError = `http-${res.status}`;
			log(`usage fetch failed: HTTP ${res.status} ${res.raw ? res.raw.slice(0, 200) : ""}`);
		}
	} catch (err) {
		lastError = "network";
		log(`usage fetch error: ${err.message}`);
	} finally {
		fetching = false;
		renderAll();
	}
}

function startTimers() {
	if (!fetchTimer) fetchTimer = setInterval(pollNow, FETCH_INTERVAL_MS);
	if (!tickTimer) tickTimer = setInterval(renderAll, TICK_INTERVAL_MS); // refresh countdown only
}
function stopTimers() {
	if (fetchTimer) clearInterval(fetchTimer), (fetchTimer = null);
	if (tickTimer) clearInterval(tickTimer), (tickTimer = null);
}

// --- Property Inspector messaging ------------------------------------------
function statusPayload() {
	return {
		type: "status",
		signedIn: isSignedIn(),
		awaitingCode: !!pendingAuth,
		error: lastError,
	};
}
function notifyStatusToAll() {
	for (const id of contexts.keys()) sendToPI(id, statusPayload());
}

async function handlePiMessage(context, payload) {
	const action = payload && payload.action;
	if (action === "signin") {
		const pkce = oauth.createPkce();
		pendingAuth = { verifier: pkce.verifier, state: pkce.state };
		const url = oauth.buildAuthorizeUrl({ challenge: pkce.challenge, state: pkce.state });
		openUrl(url);
		sendToPI(context, { type: "auth-started", url });
		return;
	}
	if (action === "exchange") {
		if (!pendingAuth) {
			sendToPI(context, { type: "auth-error", message: "Start sign-in first." });
			return;
		}
		const { code, state } = oauth.parsePastedCode(payload.value);
		if (!code) {
			sendToPI(context, { type: "auth-error", message: "Could not read a code from that input." });
			return;
		}
		// The pasted value may omit the state fragment; fall back to the one we generated.
		const stateToSend = state || pendingAuth.state;
		try {
			tokens = await oauth.exchangeCode({ code, state: stateToSend, verifier: pendingAuth.verifier });
			pendingAuth = null;
			lastError = null;
			persistTokens();
			sendToPI(context, { type: "auth-success" });
			notifyStatusToAll();
			await pollNow();
		} catch (err) {
			log(`exchange failed: ${err.message}`);
			sendToPI(context, { type: "auth-error", message: "Sign-in failed. Try again." });
		}
		return;
	}
	if (action === "signout") {
		pendingAuth = null;
		lastError = null;
		clearTokens();
		notifyStatusToAll();
		renderAll();
		return;
	}
	if (action === "refresh") {
		await pollNow();
		return;
	}
	if (action === "getStatus") {
		sendToPI(context, statusPayload());
		return;
	}
}

// --- Stream Deck event loop -------------------------------------------------
function onMessage(raw) {
	let msg;
	try {
		msg = JSON.parse(raw);
	} catch {
		return;
	}
	const { event, context, payload } = msg;

	switch (event) {
		case "didReceiveGlobalSettings": {
			const settings = payload && payload.settings;
			if (settings && settings.tokens) tokens = settings.tokens;
			renderAll();
			notifyStatusToAll();
			if (isSignedIn()) pollNow();
			break;
		}
		case "willAppear": {
			const window = (payload && payload.settings && payload.settings.window) || DEFAULT_WINDOW;
			contexts.set(context, { window });
			startTimers();
			renderContext(context);
			if (isSignedIn() && !usageData) pollNow();
			break;
		}
		case "willDisappear": {
			contexts.delete(context);
			if (contexts.size === 0) stopTimers();
			break;
		}
		case "didReceiveSettings": {
			const window = (payload && payload.settings && payload.settings.window) || DEFAULT_WINDOW;
			contexts.set(context, { window });
			renderContext(context);
			break;
		}
		case "keyDown": {
			// Tap a key to force an immediate refresh (or nudge the user to sign in).
			if (!isSignedIn()) showAlert(context);
			pollNow();
			break;
		}
		case "propertyInspectorDidAppear": {
			sendToPI(context, statusPayload());
			break;
		}
		case "sendToPlugin": {
			handlePiMessage(context, payload);
			break;
		}
		default:
			break;
	}
}

function connect() {
	ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
	ws.on("open", () => {
		sendRaw({ event: REGISTER_EVENT, uuid: PLUGIN_UUID });
		getGlobalSettings();
	});
	ws.on("message", onMessage);
	ws.on("close", () => process.exit(0));
	ws.on("error", (err) => log(`ws error: ${err.message}`));
}

if (!PORT || !PLUGIN_UUID || !REGISTER_EVENT) {
	console.error("Missing Stream Deck launch arguments; this binary is started by Stream Deck.");
	process.exit(1);
}
connect();
