// options.js
// Voice-navigable credential setup page for Convox (loaded by options.html as a module).
// Storage key: "convox_credentials"  →  { username, password }
//
// Spanish support (additive):
// - Spoken prompts and labels come from _locales via lib/i18n.js. English text is
//   identical to the previous hard-coded strings.
// - Speech recognition / TTS use the chosen language.
// - Spanish voice commands are accepted next to the English ones.
// - Usernames and passwords are never translated.
// - "Language" section: language choice, "read page content in Spanish",
//   and a button that downloads Chrome's on-device Spanish packs.

const CRED_KEY = "convox_credentials";

// ── Language layer (optional: page still works in English if it fails) ───────
let I18N = null;
let TR = null;
try {
	I18N = await import("./i18n.js");
	await I18N.initI18n();
} catch (e) {
	console.warn("[Convox options] i18n unavailable; English only.", e);
}
try {
	TR = await import("./translate.js");
} catch (e) {
	console.warn("[Convox options] translate unavailable.", e);
}

const T = (key, fallback, subs) => {
	const s = I18N?.t?.(key, subs);
	return s && s !== key ? s : fallback;
};
const getLang = () => I18N?.getLang?.() || "en";
const speechLang = () => I18N?.speechLocale?.() || "en-US";

// ── DOM refs ──────────────────────────────────────────────────────────────────
const usernameInput = document.getElementById("username");
const passwordInput = document.getElementById("password");
const saveBtn = document.getElementById("saveBtn");
const clearBtn = document.getElementById("clearBtn");
const statusEl = document.getElementById("status");
const micIndicator = document.getElementById("micIndicator");
const transcriptEl = document.getElementById("transcript-display");

const langSelect = document.getElementById("langSelect");
const translateContentEl = document.getElementById("translateContent");
const downloadLangBtn = document.getElementById("downloadLangBtn");
const langStatusEl = document.getElementById("langStatus");

// Apply localized text to elements marked with data-i18n / data-i18n-placeholder.
function applyDomI18n() {
	document.documentElement.lang = getLang();
	document.querySelectorAll("[data-i18n]").forEach((el) => {
		el.textContent = T(el.dataset.i18n, el.textContent);
	});
	document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
		el.placeholder = T(el.dataset.i18nPlaceholder, el.placeholder);
	});
}

// ── TTS ───────────────────────────────────────────────────────────────────────
let recognition = null;
let recognitionRunning = false;

function pickVoice(locale) {
	const base = locale.slice(0, 2).toLowerCase();
	const voices = window.speechSynthesis?.getVoices?.() || [];
	const same = voices.filter((v) => String(v.lang || "").toLowerCase().startsWith(base));
	return same.find((v) => v.localService) || same[0] || null;
}

function speak(text) {
	return new Promise((resolve) => {
		window.speechSynthesis.cancel();
		setMicState("speaking");

		const utter = new SpeechSynthesisUtterance(text);
		utter.rate = 1.0;
		utter.lang = speechLang();
		if (getLang() !== "en") {
			const v = pickVoice(utter.lang);
			if (v) utter.voice = v;
		}
		utter.onend = () => {
			resolve();
			restartRecognition();
		};
		utter.onerror = () => {
			resolve();
			restartRecognition();
		};
		window.speechSynthesis.speak(utter);
	});
}

// ── Mic state indicator ───────────────────────────────────────────────────────
function setMicState(state) {
	// state: "listening" | "speaking" | "off"
	micIndicator.className = "mic-indicator" + (state !== "off" ? ` ${state}` : "");
	if (state === "listening") transcriptEl.textContent = T("opt_listening", "Listening…");
	if (state === "speaking") transcriptEl.textContent = T("opt_speaking", "Speaking…");
}

// ── Status banner ─────────────────────────────────────────────────────────────
function showStatus(msg, type = "ok") {
	statusEl.textContent = msg;
	statusEl.className = `status ${type}`;
	setTimeout(() => {
		statusEl.textContent = "";
		statusEl.className = "status";
	}, 3500);
}

// ── Highlight active field ────────────────────────────────────────────────────
function highlightField(el) {
	[usernameInput, passwordInput].forEach((f) => f.classList.remove("active-field"));
	if (el) el.classList.add("active-field");
}

// ── Storage helpers ───────────────────────────────────────────────────────────
function loadCredentials() {
	return new Promise((res) => chrome.storage.local.get(CRED_KEY, (d) => res(d?.[CRED_KEY] || {})));
}

function saveCredentials(patch) {
	return new Promise((res) =>
		loadCredentials().then((current) => {
			const next = { ...current, ...patch };
			chrome.storage.local.set({ [CRED_KEY]: next }, () => res(next));
		}),
	);
}

function clearCredentials() {
	return new Promise((res) => chrome.storage.local.remove(CRED_KEY, res));
}

// ── Localized phrases ─────────────────────────────────────────────────────────
const SET = () => T("opt_set", "set");
const NOT_SET = () => T("opt_not_set", "not set");

const INSTRUCTIONS = () =>
	T(
		"opt_instructions",
		"Welcome to Convox login setup. " +
			"Here are your voice commands. " +
			"Say: set username, then your username or EUID. " +
			"Say: set password, then your password. " +
			"Say: save, to store your credentials. " +
			"Say: clear, to delete saved credentials. " +
			"Say: what did you save, to confirm what is stored. " +
			"Say: repeat, to hear these instructions again.",
	);

// ── Voice command patterns (English + Spanish) ────────────────────────────────
// Values (usernames/passwords) are captured as spoken, never translated.
const SET_VERB = "(?:set|pon|poner|establece|establecer|configura|configurar)";
const RE_REPEAT = /\b(repeat|help|instructions|what can (i|you)|repetir|repite|ayuda|instrucciones)\b/;
const RE_USERNAME = new RegExp(
	`\\b(?:${SET_VERB}\\s+(?:el\\s+|mi\\s+)?)?(?:username|user|euid|usuario)\\s+(?:is\\s+|es\\s+)?(\\S+)`,
);
const RE_PASSWORD = new RegExp(
	`(?:\\b${SET_VERB}\\s+(?:la\\s+|mi\\s+)?)?\\b(?:password|contraseña|contrasena|clave)\\s+(?:is\\s+|es\\s+)?(\\S+)`,
);
const RE_SAVE = /^\s*(save|confirm|done|yes|guardar|guarda|confirmar|listo|sí|si)\s*$/;
const RE_CLEAR = /\b(clear|delete|remove|reset|borrar|borra|eliminar|elimina|quitar)\b/;
const RE_REVIEW_EN_1 = /\b(what|confirm|check|review|show)\b.*\b(save|saved|stored|credentials)\b/;
const RE_REVIEW_EN_2 = /\b(what('?s| is) (saved|stored))\b/;
const RE_REVIEW_ES = /(?:^|\s)(?:qué|que|revisa|revisar|muestra|mostrar|confirma)\s.*\b(guardaste|guardado|guardada|guardadas|credenciales)\b/;

// ── Command handler ───────────────────────────────────────────────────────────
async function handleCommand(raw) {
	// If a field-level listener is waiting for input, delegate to it
	if (typeof window._voiceHandler === "function") {
		await window._voiceHandler(raw);
		return;
	}

	const u = raw.toLowerCase().trim();
	transcriptEl.textContent = `"${raw}"`;

	// repeat / help
	if (RE_REPEAT.test(u)) {
		await speak(INSTRUCTIONS());
		return;
	}

	// set username <value>
	const unMatch = u.match(RE_USERNAME);
	if (unMatch) {
		const value = unMatch[1];
		usernameInput.value = value;
		highlightField(usernameInput);
		await saveCredentials({ username: value });
		showStatus(T("opt_status_username_saved", "Username saved."), "ok");
		await speak(
			T(
				"opt_username_set",
				`Username set to ${value}. Say set password, then your password, or say save if you're done.`,
				[value],
			),
		);
		return;
	}

	// set password <value>
	const pwMatch = u.match(RE_PASSWORD);
	if (pwMatch) {
		const value = pwMatch[1];
		passwordInput.value = value;
		highlightField(passwordInput);
		await saveCredentials({ password: value });
		showStatus(T("opt_status_password_saved", "Password saved."), "ok");
		await speak(
			T("opt_password_set", "Password set. Say save to confirm, or set username if you haven't done that yet."),
		);
		return;
	}

	// save
	if (RE_SAVE.test(u)) {
		const creds = await loadCredentials();
		if (!creds.username && !creds.password) {
			await speak(
				T(
					"opt_nothing_to_save",
					"Nothing to save yet. Say set username, then your username, and set password, then your password.",
				),
			);
			return;
		}
		showStatus(T("opt_status_saved", "Credentials saved."), "ok");
		const user = creds.username || NOT_SET();
		const pw = creds.password ? SET() : NOT_SET();
		await speak(
			T(
				"opt_saved_voice",
				`Saved. Username is ${user}. Password is ${pw}. ` +
					"You can now close this page and say log in on the Canvas login page.",
				[user, pw],
			),
		);
		return;
	}

	// clear
	if (RE_CLEAR.test(u)) {
		await clearCredentials();
		usernameInput.value = "";
		passwordInput.value = "";
		highlightField(null);
		showStatus(T("opt_status_cleared", "Credentials cleared."), "ok");
		await speak(T("opt_cleared_voice", "Credentials cleared. Say set username to start over."));
		return;
	}

	// what did you save / confirm
	if (RE_REVIEW_EN_1.test(u) || RE_REVIEW_EN_2.test(u) || RE_REVIEW_ES.test(u)) {
		const creds = await loadCredentials();
		const unMsg = creds.username
			? T("opt_review_user", `Username is ${creds.username}.`, [creds.username])
			: T("opt_review_no_user", "No username saved.");
		const pwMsg = creds.password ? T("opt_review_pw", "Password is set.") : T("opt_review_no_pw", "No password saved.");
		await speak(`${unMsg} ${pwMsg}`);
		return;
	}

	// unrecognised
	await speak(T("opt_unrecognized", "I didn't catch that. Say repeat to hear the available commands."));
}

// ── Speech recognition ────────────────────────────────────────────────────────
function startRecognition() {
	const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
	if (!SR) {
		transcriptEl.textContent = T("opt_sr_unsupported", "Speech recognition not supported.");
		return;
	}

	recognition = new SR();
	recognition.lang = speechLang();
	recognition.continuous = false;
	recognition.interimResults = false;
	if (localSpeechOk && getLang() !== "en" && "processLocally" in recognition) {
		recognition.processLocally = true;
	}

	recognition.onstart = () => {
		recognitionRunning = true;
		setMicState("listening");
	};

	recognition.onresult = (e) => {
		const transcript = e.results[0]?.[0]?.transcript || "";
		if (transcript.trim()) handleCommand(transcript);
	};

	recognition.onerror = (e) => {
		recognitionRunning = false;
		if (e.error !== "no-speech") console.warn("SR error:", e.error);
		setTimeout(startRecognition, 500);
	};

	recognition.onend = () => {
		recognitionRunning = false;
		// only restart if we're not currently speaking (speak() calls restartRecognition on end)
		if (!window.speechSynthesis.speaking) setTimeout(startRecognition, 300);
	};

	recognition.start();
}

function restartRecognition() {
	setMicState("listening");
	if (!recognitionRunning) startRecognition();
}

// ── Button click handlers (mouse fallback) ────────────────────────────────────
saveBtn.addEventListener("click", async () => {
	const creds = { username: usernameInput.value.trim(), password: passwordInput.value };
	if (!creds.username && !creds.password) {
		showStatus(T("opt_status_enter", "Please enter a username or password."), "err");
		return;
	}
	await saveCredentials(creds);
	showStatus(T("opt_status_saved", "Credentials saved."), "ok");
	const user = creds.username || NOT_SET();
	const pw = creds.password ? SET() : NOT_SET();
	await speak(T("opt_saved_short", `Saved. Username is ${user}. Password is ${pw}.`, [user, pw]));
});

clearBtn.addEventListener("click", async () => {
	await clearCredentials();
	usernameInput.value = "";
	passwordInput.value = "";
	showStatus(T("opt_status_cleared", "Credentials cleared."), "ok");
	await speak(T("opt_status_cleared", "Credentials cleared."));
});

// ── Language section (Spanish support) ────────────────────────────────────────
let localSpeechOk = false;

async function refreshLanguageStatus() {
	if (!langStatusEl) return;
	const lines = [];

	if (TR) {
		const st = await TR.languagePackStatus("es", "en");
		const key =
			{
				available: "opt_pack_available",
				downloadable: "opt_pack_downloadable",
				downloading: "opt_pack_downloading",
				unavailable: "opt_pack_unavailable",
			}[st] || "opt_pack_unsupported";
		lines.push(T(key, ""));

		const esLocale = I18N?.speechLocale?.("es") || "es-US";
		localSpeechOk = (await TR.localSpeechStatus(esLocale)) === "available";
		lines.push(localSpeechOk ? T("opt_voice_local", "") : T("opt_voice_cloud", ""));
	} else {
		lines.push(T("opt_pack_unsupported", "Spanish translation isn't supported in this version of Chrome."));
	}

	langStatusEl.replaceChildren(
		...lines.filter(Boolean).map((text) => {
			const p = document.createElement("p");
			p.textContent = text;
			return p;
		}),
	);
}

// Must be called synchronously inside the click/change handler (downloads need a user gesture).
function startSpanishDownloads() {
	if (!TR) return null;
	let lastPct = -25;
	const packs = TR.prepareSpanish({
		onProgress: (loaded) => {
			const pct = Math.round((loaded || 0) * 100);
			if (pct - lastPct >= 25 || pct === 100) {
				lastPct = pct;
				if (langStatusEl) langStatusEl.textContent = T("opt_download_progress", `Downloading… ${pct}%`, [pct]);
			}
		},
	});
	const speech = TR.installLocalSpeech(I18N?.speechLocale?.("es") || "es-US");
	return Promise.allSettled([packs, speech]);
}

async function initLanguageSection() {
	if (!langSelect) return;

	langSelect.value = getLang();
	if (translateContentEl && TR) translateContentEl.checked = await TR.getTranslateContent();
	if (translateContentEl && !TR) translateContentEl.disabled = true;
	if (downloadLangBtn && !TR) downloadLangBtn.disabled = true;

	langSelect.addEventListener("change", async () => {
		const next = langSelect.value;
		const downloads = next === "es" ? startSpanishDownloads() : null; // before any await
		await I18N?.setLang?.(next);
		applyDomI18n();
		if (recognition) recognition.lang = speechLang();
		await speak(T("msg_lang_switched", next === "es" ? "Idioma: español." : "Language: English."));
		if (downloads) await downloads;
		await refreshLanguageStatus();
	});

	translateContentEl?.addEventListener("change", () => {
		TR?.setTranslateContent?.(translateContentEl.checked);
	});

	downloadLangBtn?.addEventListener("click", async () => {
		const downloads = startSpanishDownloads(); // before any await
		if (downloads) await downloads;
		await refreshLanguageStatus();
	});

	await refreshLanguageStatus();
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
	applyDomI18n();
	await initLanguageSection();

	const creds = await loadCredentials();
	if (creds.username) usernameInput.value = creds.username;
	if (creds.password) passwordInput.value = creds.password;

	const autofocus = new URLSearchParams(window.location.search).get("autofocus") === "true";
	const noCredentials = !creds.username && !creds.password;

	if (autofocus || noCredentials) {
		await promptUsernameEntry();
	} else {
		await speak(INSTRUCTIONS());
	}
}

async function promptUsernameEntry() {
	highlightField(usernameInput);
	usernameInput.focus();
	await speak(
		T("opt_prompt_username", "No saved credentials were found. Please type or say your username or EUID now."),
	);
	await waitForField(usernameInput, "username", async () => {
		await promptPasswordEntry();
	});
}

async function promptPasswordEntry() {
	highlightField(passwordInput);
	passwordInput.focus();
	await speak(T("opt_prompt_password", "Got it. Now type or say your password."));
	await waitForField(passwordInput, "password", async () => {
		const creds = await loadCredentials();
		const user = creds.username || NOT_SET();
		const pw = creds.password ? SET() : NOT_SET();
		await speak(
			T(
				"opt_setup_complete",
				`Setup complete. Username is ${user} and password is ${pw}. ` +
					"You can close this page and say log in again.",
				[user, pw],
			),
		);
	});
}

// Waits for either a voice command or the field to be filled by typing,
// then saves and calls onDone.
function waitForField(inputEl, fieldName, onDone) {
	return new Promise((resolve) => {
		let done = false;

		async function finish(value) {
			if (done) return;
			done = true;
			const patch = {};
			patch[fieldName] = value;
			await saveCredentials(patch);
			inputEl.value = value;
			highlightField(null);
			resolve();
			await onDone();
		}

		// Listen for typing — save when user stops typing for 1.5s
		let typingTimer;
		inputEl.addEventListener(
			"input",
			() => {
				clearTimeout(typingTimer);
				typingTimer = setTimeout(() => {
					if (inputEl.value.trim()) finish(inputEl.value.trim());
				}, 1500);
			},
			{ once: false },
		);

		// Also listen for voice — override the main handleCommand for this turn
		const origHandler = window._voiceHandler;
		// Same word set as before (either field word is accepted), plus Spanish.
		const fieldWords = `${fieldName}|user(?:name)?|euid|pass(?:word)?|usuario|contraseña|contrasena|clave`;
		const fieldRe = new RegExp(`(?:\\b${SET_VERB}\\s+(?:el\\s+|la\\s+|mi\\s+)?)?\\b(?:${fieldWords})\\s+(?:is\\s+|es\\s+)?(\\S+)`);
		const spokenFieldName =
			fieldName === "username" ? T("opt_field_username", "username") : T("opt_field_password", "password");

		window._voiceHandler = async (raw) => {
			const u = raw.toLowerCase().trim();
			transcriptEl.textContent = `"${raw}"`;

			// Extract value from "set username abc123" / "usuario abc123" or just "abc123"
			const match = u.match(fieldRe) || u.match(/^(\S+)$/);

			if (match?.[1]) {
				window._voiceHandler = origHandler; // restore
				await finish(match[1]);
			} else {
				await speak(
					T("opt_field_retry", `I didn't catch that. Please say your ${spokenFieldName}.`, [spokenFieldName]),
				);
			}
		};
	});
}

init();
