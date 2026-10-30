// lib/i18n.js
// Canvox localization layer (fully offline, no network).
//
// Source of truth: _locales/<lang>/messages.json, the same files Chrome uses
// for chrome.i18n and for __MSG_*__ strings in manifest.json.
//
// Why not chrome.i18n.getMessage() alone? It always follows the *browser's*
// UI language and cannot be switched at runtime. Canvox lets the user choose a
// language, so we read the chosen locale file from the extension package
// (a local chrome-extension:// read) and fall back to chrome.i18n.getMessage().
//
// The selected language is stored in chrome.storage.sync, next to Convox's
// other settings (theme, hotkeys, volume), so the content script, options page
// and background all agree on it. (Page localStorage is per-origin and would
// differ between sites.)
//
// IMPORTANT: import this module WITHOUT a ?v= query string. Module identity is
// the full URL, so "i18n.js?v=1" and "./i18n.js" would be two separate copies
// with two separate language states.

export const SUPPORTED_LANGS = ["en", "es"];
export const LANG_STORAGE_KEY = "canvoxLang";

// Locale used for speech recognition and TTS. es-US suits US users; change to
// "es-ES" or "es-MX" if that fits your audience better.
const SPEECH_LOCALES = { en: "en-US", es: "es-US" };

let current = "en";
let table = null; // parsed messages.json for `current`
let initPromise = null;
const listeners = new Set();

export function normalizeLang(lang) {
	const base = String(lang || "")
		.toLowerCase()
		.split(/[-_]/)[0];
	return SUPPORTED_LANGS.includes(base) ? base : "en";
}

async function loadTable(lang) {
	try {
		const res = await fetch(chrome.runtime.getURL(`_locales/${lang}/messages.json`));
		return res.ok ? await res.json() : null;
	} catch {
		return null;
	}
}

async function applyLang(lang) {
	const next = normalizeLang(lang);
	if (next === current && table) return current;
	const loaded = await loadTable(next);
	current = next;
	table = loaded;
	for (const fn of listeners) {
		try {
			fn(current);
		} catch {}
	}
	return current;
}

// Default stays English unless the user has chosen otherwise, so existing
// behaviour is unchanged for everyone who never touches the setting.
export function initI18n() {
	if (initPromise) return initPromise;
	initPromise = (async () => {
		let stored = null;
		try {
			stored = (await chrome.storage.sync.get(LANG_STORAGE_KEY))?.[LANG_STORAGE_KEY];
		} catch {}
		await applyLang(stored || "en");
		try {
			chrome.storage.onChanged.addListener((changes, area) => {
				if (area === "sync" && changes[LANG_STORAGE_KEY]) {
					applyLang(changes[LANG_STORAGE_KEY].newValue);
				}
			});
		} catch {}
		return current;
	})();
	return initPromise;
}

export function getLang() {
	return current;
}

export async function setLang(lang) {
	const next = normalizeLang(lang);
	try {
		await chrome.storage.sync.set({ [LANG_STORAGE_KEY]: next });
	} catch {}
	return applyLang(next);
}

export function onLangChange(fn) {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

export function speechLocale(lang = current) {
	return SPEECH_LOCALES[normalizeLang(lang)] || "en-US";
}

// t("key", ["sub1", "sub2"]) -> localized string; returns the key if missing.
export function t(key, subs = []) {
	const arr = (Array.isArray(subs) ? subs : [subs]).map((s) => String(s ?? ""));
	const entry = table?.[key];
	if (entry?.message) return substitute(entry, arr);
	try {
		const m = chrome.i18n.getMessage(key, arr);
		if (m) return m;
	} catch {}
	return key;
}

// Implements chrome.i18n placeholder rules: named $NAME$ placeholders whose
// "content" refers to positional $1..$9 substitutions.
function substitute(entry, subs) {
	const ph = entry.placeholders || {};
	const positional = (s) => String(s).replace(/\$(\d)/g, (_, i) => subs[Number(i) - 1] ?? "");
	const named = entry.message.replace(/\$([A-Za-z0-9_@]+)\$/g, (m, name) => {
		const p = ph[name.toLowerCase()];
		return p ? positional(p.content) : m;
	});
	return positional(named);
}
