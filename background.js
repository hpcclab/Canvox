"use strict";
import { getSettingWithDefault, DEFAULT_SETTINGS } from "./src/model/settings.js";

// =============================================================================
// Convox MV3 Service Worker / Background
// - Initializes default settings on install
// - Answers popup/content queries (mic status)
// - ✅ Performs hard, top-level tab navigation for course opens (fixes “pending click fires later”)
// =============================================================================

// Listen for installation
chrome.runtime.onInstalled.addListener(({ reason }) => {
	if (reason === "install") {
		chrome.storage.sync.set(DEFAULT_SETTINGS, () => {
			console.log("Default settings initialized");
		});
	}
});

// Small helper: get sender tab id safely
function getSenderTabId(sender) {
	return sender?.tab?.id ?? null;
}

// Small helper: normalize/validate URL (allow relative to sender origin)
function normalizeUrl(rawUrl, sender) {
	try {
		const sUrl = String(rawUrl || "").trim();
		if (!sUrl) return null;

		// If it's already absolute, this will work.
		// If it's relative, resolve against sender tab URL (best), then fallback to location.origin.
		const base =
			(sender?.tab?.url && String(sender.tab.url)) ||
			(location?.origin ? String(location.origin) : "https://canvas.instructure.com");

		return new URL(sUrl, base).toString();
	} catch {
		return null;
	}
}

// Set up message passing between popup and content scripts if needed
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	try {
		// ------------------------------------------------------------
		// Existing: microphone status
		// ------------------------------------------------------------
		if (message?.action === "getMicrophoneStatus") {
			chrome.storage.sync.get("microphoneActive", (data) => {
				sendResponse({ microphoneActive: data?.microphoneActive || false });
			});
			return true; // async
		}

		// ------------------------------------------------------------
		// ✅ NEW: Hard navigate the current tab (top-level) — reliable
		// Content script should call:
		// chrome.runtime.sendMessage({ action: "CONVOX_NAVIGATE", url })
		// ------------------------------------------------------------
		if (message?.action === "CONVOX_NAVIGATE") {
			const tabId = getSenderTabId(sender);
			const url = normalizeUrl(message?.url, sender);

			if (!tabId) {
				sendResponse({ ok: false, error: "No sender tab id" });
				return false;
			}
			if (!url) {
				sendResponse({ ok: false, error: "Invalid or empty URL" });
				return false;
			}

			chrome.tabs.update(tabId, { url }, () => {
				const err = chrome.runtime.lastError;
				if (err) {
					sendResponse({ ok: false, error: err.message || String(err) });
				} else {
					sendResponse({ ok: true, url });
				}
			});

			return true; // async
		}

		// ------------------------------------------------------------
		// (Optional) You can add more actions later...
		// ------------------------------------------------------------
	} catch (e) {
		sendResponse({ ok: false, error: String(e?.message || e) });
	}

	return false;
});
