// options.js
// Voice-navigable credential setup page for Convox.
// Storage key: "convox_credentials"  →  { username, password }

const CRED_KEY = "convox_credentials";

// ── DOM refs ──────────────────────────────────────────────────────────────────
const usernameInput   = document.getElementById("username");
const passwordInput   = document.getElementById("password");
const saveBtn         = document.getElementById("saveBtn");
const clearBtn        = document.getElementById("clearBtn");
const statusEl        = document.getElementById("status");
const micIndicator    = document.getElementById("micIndicator");
const transcriptEl    = document.getElementById("transcript-display");

// ── TTS ───────────────────────────────────────────────────────────────────────
let recognition = null;
let recognitionRunning = false;

function speak(text) {
	return new Promise((resolve) => {
		window.speechSynthesis.cancel();
		setMicState("speaking");

		const utter = new SpeechSynthesisUtterance(text);
		utter.rate = 1.0;
		utter.lang = "en-US";
		utter.onend  = () => { resolve(); restartRecognition(); };
		utter.onerror = () => { resolve(); restartRecognition(); };
		window.speechSynthesis.speak(utter);
	});
}

// ── Mic state indicator ───────────────────────────────────────────────────────
function setMicState(state) {
	// state: "listening" | "speaking" | "off"
	micIndicator.className = "mic-indicator" + (state !== "off" ? ` ${state}` : "");
	if (state === "listening") transcriptEl.textContent = "Listening…";
	if (state === "speaking")  transcriptEl.textContent = "Speaking…";
}

// ── Status banner ─────────────────────────────────────────────────────────────
function showStatus(msg, type = "ok") {
	statusEl.textContent = msg;
	statusEl.className = `status ${type}`;
	setTimeout(() => { statusEl.textContent = ""; statusEl.className = "status"; }, 3500);
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
		})
	);
}

function clearCredentials() {
	return new Promise((res) => chrome.storage.local.remove(CRED_KEY, res));
}

// ── Instructions ──────────────────────────────────────────────────────────────
const INSTRUCTIONS =
	"Welcome to Convox login setup. " +
	"Here are your voice commands. " +
	"Say: set username, then your username or EUID. " +
	"Say: set password, then your password. " +
	"Say: save, to store your credentials. " +
	"Say: clear, to delete saved credentials. " +
	"Say: what did you save, to confirm what is stored. " +
	"Say: repeat, to hear these instructions again.";

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
	if (/\b(repeat|help|instructions|what can (i|you))\b/.test(u)) {
		await speak(INSTRUCTIONS);
		return;
	}

	// set username <value>
	const unMatch = u.match(/\b(?:set\s+)?(?:username|user|euid)\s+(?:is\s+)?(\S+)/);
	if (unMatch) {
		const value = unMatch[1];
		usernameInput.value = value;
		highlightField(usernameInput);
		await saveCredentials({ username: value });
		showStatus("Username saved.", "ok");
		await speak(`Username set to ${value}. Say set password, then your password, or say save if you're done.`);
		return;
	}

	// set password <value>
	const pwMatch = u.match(/\b(?:set\s+)?password\s+(?:is\s+)?(\S+)/);
	if (pwMatch) {
		const value = pwMatch[1];
		passwordInput.value = value;
		highlightField(passwordInput);
		await saveCredentials({ password: value });
		showStatus("Password saved.", "ok");
		await speak("Password set. Say save to confirm, or set username if you haven't done that yet.");
		return;
	}

	// save
	if (/^\s*(save|confirm|done|yes)\s*$/.test(u)) {
		const creds = await loadCredentials();
		if (!creds.username && !creds.password) {
			await speak("Nothing to save yet. Say set username, then your username, and set password, then your password.");
			return;
		}
		showStatus("Credentials saved.", "ok");
		await speak(
			`Saved. Username is ${creds.username || "not set"}. Password is ${creds.password ? "set" : "not set"}. ` +
			"You can now close this page and say log in on the Canvas login page."
		);
		return;
	}

	// clear
	if (/\b(clear|delete|remove|reset)\b/.test(u)) {
		await clearCredentials();
		usernameInput.value = "";
		passwordInput.value = "";
		highlightField(null);
		showStatus("Credentials cleared.", "ok");
		await speak("Credentials cleared. Say set username to start over.");
		return;
	}

	// what did you save / confirm
	if (/\b(what|confirm|check|review|show)\b.*\b(save|saved|stored|credentials)\b/.test(u) ||
		/\b(what('?s| is) (saved|stored))\b/.test(u)) {
		const creds = await loadCredentials();
		const unMsg = creds.username ? `Username is ${creds.username}.` : "No username saved.";
		const pwMsg = creds.password ? "Password is set." : "No password saved.";
		await speak(`${unMsg} ${pwMsg}`);
		return;
	}

	// unrecognised
	await speak("I didn't catch that. Say repeat to hear the available commands.");
}

// ── Speech recognition ────────────────────────────────────────────────────────
function startRecognition() {
	const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
	if (!SR) {
		transcriptEl.textContent = "Speech recognition not supported.";
		return;
	}

	recognition = new SR();
	recognition.lang = "en-US";
	recognition.continuous = false;
	recognition.interimResults = false;

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
		showStatus("Please enter a username or password.", "err");
		return;
	}
	await saveCredentials(creds);
	showStatus("Credentials saved.", "ok");
	await speak(`Saved. Username is ${creds.username || "not set"}. Password is ${creds.password ? "set" : "not set"}.`);
});

clearBtn.addEventListener("click", async () => {
	await clearCredentials();
	usernameInput.value = "";
	passwordInput.value = "";
	showStatus("Credentials cleared.", "ok");
	await speak("Credentials cleared.");
});

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
	const creds = await loadCredentials();
	if (creds.username) usernameInput.value = creds.username;
	if (creds.password) passwordInput.value = creds.password;

	const autofocus = new URLSearchParams(window.location.search).get("autofocus") === "true";
	const noCredentials = !creds.username && !creds.password;

	if (autofocus || noCredentials) {
		await promptUsernameEntry();
	} else {
		await speak(INSTRUCTIONS);
	}
}

async function promptUsernameEntry() {
	highlightField(usernameInput);
	usernameInput.focus();
	await speak("No saved credentials were found. Please type or say your username or EUID now.");
	await waitForField(usernameInput, "username", async () => {
		await promptPasswordEntry();
	});
}

async function promptPasswordEntry() {
	highlightField(passwordInput);
	passwordInput.focus();
	await speak("Got it. Now type or say your password.");
	await waitForField(passwordInput, "password", async () => {
		const creds = await loadCredentials();
		await speak(
			`Setup complete. Username is ${creds.username || "not set"} and password is ${creds.password ? "set" : "not set"}. ` +
			"You can close this page and say log in again."
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
		inputEl.addEventListener("input", () => {
			clearTimeout(typingTimer);
			typingTimer = setTimeout(() => {
				if (inputEl.value.trim()) finish(inputEl.value.trim());
			}, 1500);
		}, { once: false });

		// Also listen for voice — override the main handleCommand for this turn
		const origHandler = window._voiceHandler;
		window._voiceHandler = async (raw) => {
			const u = raw.toLowerCase().trim();
			transcriptEl.textContent = `"${raw}"`;

			// Extract value from "set username abc123" or just "abc123"
			const match =
				u.match(new RegExp(`\\b(?:set\\s+)?(?:${fieldName}|user(?:name)?|euid|pass(?:word)?)\\s+(?:is\\s+)?(\\S+)`)) ||
				u.match(/^(\S+)$/);

			if (match?.[1]) {
				window._voiceHandler = origHandler; // restore
				await finish(match[1]);
			} else {
				await speak(`I didn't catch that. Please say your ${fieldName}.`);
			}
		};
	});
}

init();
