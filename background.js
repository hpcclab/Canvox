//"use strict";
//import { DEFAULT_SETTINGS } from "./src/model/settings.js";

"use strict";

import { DEFAULT_SETTINGS } from "./src/model/settings.js";

//temporary testing code for geminiPlanner.js
/*
import { createGeminiPlanner } from "./src/model/geminiPlanner.js";

console.log(
  "[Canvox] Gemini planner import:",
  typeof createGeminiPlanner
);

(async () => {
  let planner;

  try {
    planner = await createGeminiPlanner();

    const plan = await planner.plan(
      "Open my Canvas calendar."
    );

    console.log("[Canvox] Test plan:", plan);
  } catch (error) {
    console.error("[Canvox] Planner test failed:", error);
  } finally {
    planner?.destroy();
  }
})();
*/

// =============================================================================
// Convox MV3 Service Worker / Background
// =============================================================================

// Spanish support: Convox's language lives in chrome.storage.sync next to the
// other settings. Default is English, so existing users see no change.
// (Kept here instead of src/model/settings.js so that file's import chain is
// not made any heavier for the service worker.)
const LANG_STORAGE_KEY = "canvoxLang";
const DEFAULT_LANG = "en";

function ensureDefaultLanguage() {
	chrome.storage.sync.get(LANG_STORAGE_KEY, (data) => {
		if (chrome.runtime.lastError) return;
		if (!data?.[LANG_STORAGE_KEY]) {
			chrome.storage.sync.set({ [LANG_STORAGE_KEY]: DEFAULT_LANG });
		}
	});
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
	if (reason === "install") {
		chrome.storage.sync.set(DEFAULT_SETTINGS, () => {
			console.log("Default settings initialized");
		});
	}
	// On install AND update: add the language default without touching anything else.
	if (reason === "install" || reason === "update") {
		ensureDefaultLanguage();
	}
});

function getSenderTabId(sender) {
	return sender?.tab?.id ?? null;
}

function normalizeUrl(rawUrl, sender) {
	try {
		const sUrl = String(rawUrl || "").trim();
		if (!sUrl) return null;

		const base = (sender?.tab?.url && String(sender.tab.url)) || "https://canvas.instructure.com";

		return new URL(sUrl, base).toString();
	} catch {
		return null;
	}
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	try {
		const kind = message?.action || message?.type;

		if (kind === "getMicrophoneStatus") {
			chrome.storage.sync.get("microphoneActive", (data) => {
				sendResponse({ microphoneActive: data?.microphoneActive || false });
			});
			return true;
		}

		if (kind === "CONVOX_NAVIGATE") {
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

			return true;
		}

		if (kind === "openOptionsPage") {
			const url = chrome.runtime.getURL("options.html?autofocus=true");
			chrome.tabs.create({ url });
			sendResponse({ ok: true });
			return false;
		}
	} catch (e) {
		sendResponse({ ok: false, error: String(e?.message || e) });
	}

	return false;
});
