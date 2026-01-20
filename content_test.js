// content_test.js
// Test interface for Convox extension - logs conversation transcript and captures TTS output.
// Updates requested:
//  - Persistent logs across page navigations/reloads (until Clear is pressed)
//  - Shortcut keys for each button
//  - Help button (speaks + logs shortcuts)
//  - Minimize button to hide UI (and shortcut)
//  - Keep logs (do NOT auto-clear on page change)

(async () => {
	// --- helpers ---------------------------------------------------------------
	function logToast(msg, ...rest) {
		console.log("[Convox Test]", msg, ...rest);
	}

	// ---- persistent transcript store -----------------------------------------
	const STORE_KEY = "convox_test_transcript_v1";
	const UI_KEY = "convox_test_ui_state_v1";

	function safeJSONParse(s, fallback) {
		try {
			return JSON.parse(s);
		} catch {
			return fallback;
		}
	}

	function loadState() {
		const raw = localStorage.getItem(STORE_KEY);
		const arr = safeJSONParse(raw, []);
		return Array.isArray(arr) ? arr : [];
	}

	function saveState() {
		try {
			localStorage.setItem(STORE_KEY, JSON.stringify(convo));
		} catch (e) {
			// storage can fail (quota/private mode) - still keep in-memory
			console.warn("[Convox Test] Failed to persist transcript:", e);
		}
	}

	function loadUIState() {
		const raw = localStorage.getItem(UI_KEY);
		const st = safeJSONParse(raw, {});
		return st && typeof st === "object" ? st : {};
	}

	function saveUIState(patch) {
		const cur = loadUIState();
		const next = { ...cur, ...patch };
		try {
			localStorage.setItem(UI_KEY, JSON.stringify(next));
		} catch {}
		return next;
	}

	// ---- conversation transcript ---------------------------------------------
	let convo = loadState(); // { role: "user"|"convox"|"system", text, ts }
	function nowTS() {
		try {
			return new Date().toLocaleTimeString();
		} catch {
			return "";
		}
	}
	function pushConvo(role, text) {
		const line = String(text ?? "").trim();
		if (!line) return;
		convo.push({ role, text: line, ts: nowTS() });
		saveState();
		renderLog();
	}
	function convoToText() {
		return convo
			.map((m) => {
				const who = m.role === "user" ? "You" : m.role === "convox" ? "Convox" : "System";
				return `[${m.ts}] ${who}: ${m.text}`;
			})
			.join("\n");
	}

	// --- TTS capture (monkey-patch) -------------------------------------------
	let ttsPatched = false;
	function patchTTSOnce() {
		if (ttsPatched) return;
		ttsPatched = true;

		if (!("speechSynthesis" in window) || typeof window.speechSynthesis?.speak !== "function") {
			pushConvo("system", "speechSynthesis not available; cannot capture Convox speech.");
			return;
		}

		const synth = window.speechSynthesis;
		const originalSpeak = synth.speak.bind(synth);

		synth.speak = (utter) => {
			try {
				const spoken = utter?.text ?? "";
				if (spoken) pushConvo("convox", spoken);
			} catch {
				// ignore logging failures
			}
			return originalSpeak(utter);
		};

		pushConvo("system", "TTS capture enabled (Convox speech will appear in transcript).");
	}

	async function diagnose() {
		const parts = [];
		parts.push(`URL: ${location.host}${location.pathname}`);
		parts.push(`speechSynthesis: ${"speechSynthesis" in window ? "available" : "missing"}`);
		const links = Array.from(document.querySelectorAll("a, [role='link']"));
		const sample = links
			.slice(0, 10)
			.map((a) => (a.textContent || "").trim())
			.filter(Boolean)
			.slice(0, 5);
		parts.push(`links on page: ${links.length} (sample: ${sample.join(" | ") || "—"})`);
		try {
			const { speak } = await safeImportActions();
			speak("Convox self-test: Speech is working.");
			parts.push("TTS check: attempted to speak a test line.");
		} catch {
			parts.push("TTS check: failed to import speak()");
		}
		alert("Convox Diagnose:\n\n" + parts.join("\n"));
	}

	// --- robust importer with one-time auto-reload -----------------------------
	let reloadedOnce = false;
	async function safeImportActions() {
		try {
			const url = chrome.runtime.getURL("lib/actions.js");
			return await import(url);
		} catch (err) {
			const msg = String(err?.message || err);
			if (msg.includes("Extension context invalidated")) {
				logToast("Detected invalidated context. Attempting one-time page reload to re-inject content script.");
				if (!reloadedOnce) {
					reloadedOnce = true;
					alert("Convox was just reloaded. I’ll refresh this page once so testing can continue.");
					location.reload();
				}
				throw err;
			}
			throw err;
		}
	}

	async function runUtterance(text) {
		const { handleUtterance, initAutoResume } = await safeImportActions();
		initAutoResume(); // ensure auto-resume is active
		pushConvo("user", text);

		const out = await handleUtterance(text);
		logToast(out);

		try {
			const intent = out?.intent || "UNKNOWN";
			const conf = out?.result?.confidence;
			const reason = out?.result?.reason;
			const meta =
				typeof conf === "number"
					? `Intent: ${intent} (conf ${conf.toFixed(2)})${reason ? ` — ${reason}` : ""}`
					: `Intent: ${intent}${reason ? ` — ${reason}` : ""}`;
			pushConvo("system", meta);
		} catch {
			// ignore
		}
	}

	// --- prompt + speech UI ---------------------------------------------------
	let logEl = null;
	let inputEl = null;

	let copyBtn = null;
	let clearBtn = null;
	let helpBtn = null;
	let minimizeBtn = null;

	let micBtn = null;
	let stopSpeakBtn = null;
	let submitBtn = null;

	let recognizer = null;
	let listening = false;
	let autoSubmitTimer = null;

	function renderLog() {
		if (!logEl) return;
		logEl.value = convoToText();
		try {
			logEl.scrollTop = logEl.scrollHeight;
		} catch {}
	}

	async function copyConversation() {
		const txt = convoToText();
		try {
			await navigator.clipboard.writeText(txt);
			pushConvo("system", "Conversation copied to clipboard.");
		} catch {
			try {
				const ta = document.createElement("textarea");
				ta.value = txt;
				document.body.appendChild(ta);
				ta.select();
				document.execCommand("copy");
				document.body.removeChild(ta);
				pushConvo("system", "Conversation copied to clipboard.");
			} catch {
				alert("Copy failed. You can manually select and copy from the log box.");
			}
		}
	}

	function clearConversation() {
		convo = [];
		try {
			localStorage.removeItem(STORE_KEY);
		} catch {}
		pushConvo("system", "Conversation cleared.");
		renderLog();
	}

	function stopSpeaking() {
		try {
			window.speechSynthesis?.cancel?.();
			pushConvo("system", "Stopped speaking.");
		} catch {}
	}

	function stopListening() {
		try {
			recognizer?.stop?.();
		} catch {}
	}

	function speakHelp() {
		const msg =
			"Convox Test shortcuts: Alt plus L to listen or stop. Alt plus S to submit. Alt plus X to stop speaking. Alt plus C to copy. Alt plus R to clear. Alt plus H for help. Alt plus M to minimize or show. Alt plus D to diagnose. Alt plus F to focus the command box.";
		pushConvo("system", "Help: " + msg);
		try {
			// speak through native TTS so it shows in transcript too (captured)
			const u = new SpeechSynthesisUtterance(msg);
			window.speechSynthesis.cancel();
			window.speechSynthesis.speak(u);
		} catch {}
	}

	function setMinimized(container, content, minimized) {
		content.style.display = minimized ? "none" : "block";
		minimizeBtn.textContent = minimized ? "➕ Show" : "➖ Min";
		saveUIState({ minimized });
	}

	function focusInput() {
		try {
			inputEl?.focus?.();
		} catch {}
	}

	function ensureTestUI() {
		if (document.getElementById("convox-test-container")) return;

		patchTTSOnce();

		const uiSt = loadUIState();
		const defaultMin = !!uiSt.minimized;

		const container = document.createElement("div");
		container.id = "convox-test-container";
		Object.assign(container.style, {
			position: "fixed",
			bottom: "16px",
			right: "16px",
			zIndex: "2147483647",
			fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
			background: "#111",
			color: "#fff",
			borderRadius: "12px",
			boxShadow: "0 2px 10px rgba(0,0,0,0.25)",
			padding: "8px",
			width: "360px",
		});

		// Header row with buttons
		const headerRow = document.createElement("div");
		Object.assign(headerRow.style, { display: "flex", alignItems: "center", justifyContent: "space-between" });
		container.appendChild(headerRow);

		const header = document.createElement("div");
		header.textContent = "Convox Test 🔊";
		header.style.fontWeight = "bold";
		header.style.userSelect = "none";
		headerRow.appendChild(header);

		const headerBtns = document.createElement("div");
		Object.assign(headerBtns.style, { display: "flex", gap: "6px" });
		headerRow.appendChild(headerBtns);

		helpBtn = document.createElement("button");
		helpBtn.textContent = "❓ Help";
		Object.assign(helpBtn.style, {
			padding: "6px",
			borderRadius: "8px",
			border: "none",
			cursor: "pointer",
			background: "#333",
			color: "#fff",
			fontSize: "12px",
		});
		helpBtn.title = "Help (Alt+H)";
		helpBtn.addEventListener("click", speakHelp);
		headerBtns.appendChild(helpBtn);

		minimizeBtn = document.createElement("button");
		minimizeBtn.textContent = defaultMin ? "➕ Show" : "➖ Min";
		Object.assign(minimizeBtn.style, {
			padding: "6px",
			borderRadius: "8px",
			border: "none",
			cursor: "pointer",
			background: "#333",
			color: "#fff",
			fontSize: "12px",
		});
		minimizeBtn.title = "Minimize/Show (Alt+M)";
		headerBtns.appendChild(minimizeBtn);

		const content = document.createElement("div");
		content.style.marginTop = "8px";
		container.appendChild(content);

		minimizeBtn.addEventListener("click", () => {
			const minimized = content.style.display !== "none";
			setMinimized(container, content, minimized);
		});

		// transcript (text form)
		logEl = document.createElement("textarea");
		logEl.id = "convox-test-log";
		logEl.readOnly = true;
		logEl.placeholder = "Conversation transcript will appear here…";
		Object.assign(logEl.style, {
			width: "100%",
			height: "160px",
			resize: "none",
			padding: "8px",
			borderRadius: "8px",
			border: "1px solid rgba(255,255,255,0.12)",
			background: "#0b0b0b",
			color: "#fff",
			marginBottom: "8px",
			lineHeight: "1.25",
			fontSize: "12px",
		});
		content.appendChild(logEl);

		// row: copy / clear / diagnose
		const row1 = document.createElement("div");
		Object.assign(row1.style, { display: "flex", gap: "6px", marginBottom: "8px" });
		content.appendChild(row1);

		copyBtn = document.createElement("button");
		copyBtn.textContent = "📋 Copy";
		Object.assign(copyBtn.style, {
			flex: "1",
			padding: "8px",
			borderRadius: "8px",
			border: "none",
			cursor: "pointer",
			background: "#444",
			color: "#fff",
		});
		copyBtn.title = "Copy transcript (Alt+C)";
		copyBtn.addEventListener("click", copyConversation);
		row1.appendChild(copyBtn);

		clearBtn = document.createElement("button");
		clearBtn.textContent = "🧹 Clear";
		Object.assign(clearBtn.style, {
			flex: "1",
			padding: "8px",
			borderRadius: "8px",
			border: "none",
			cursor: "pointer",
			background: "#444",
			color: "#fff",
		});
		clearBtn.title = "Clear transcript (Alt+R)";
		clearBtn.addEventListener("click", clearConversation);
		row1.appendChild(clearBtn);

		const diagBtn = document.createElement("button");
		diagBtn.textContent = "🩺 Diagnose";
		Object.assign(diagBtn.style, {
			flex: "1",
			padding: "8px",
			borderRadius: "8px",
			border: "none",
			cursor: "pointer",
			background: "#444",
			color: "#fff",
		});
		diagBtn.title = "Diagnose (Alt+D)";
		diagBtn.addEventListener("click", () => {
			pushConvo("user", "diagnose");
			diagnose();
		});
		row1.appendChild(diagBtn);

		// text input
		inputEl = document.createElement("input");
		inputEl.type = "text";
		inputEl.placeholder = "Type a command or use mic 🎤";
		Object.assign(inputEl.style, {
			width: "100%",
			padding: "10px",
			borderRadius: "10px",
			border: "none",
			marginBottom: "8px",
		});
		inputEl.title = "Focus command box (Alt+F)";
		content.appendChild(inputEl);

		// mic button
		micBtn = document.createElement("button");
		micBtn.textContent = "🎤 Listen";
		Object.assign(micBtn.style, {
			width: "100%",
			padding: "10px",
			borderRadius: "10px",
			border: "none",
			cursor: "pointer",
			background: "#444",
			color: "#fff",
			marginBottom: "8px",
		});
		micBtn.title = "Listen/Stop listening (Alt+L)";
		content.appendChild(micBtn);

		// stop speaking
		stopSpeakBtn = document.createElement("button");
		stopSpeakBtn.textContent = "🛑 Stop speaking";
		Object.assign(stopSpeakBtn.style, {
			width: "100%",
			padding: "10px",
			borderRadius: "10px",
			border: "none",
			cursor: "pointer",
			background: "#b00020",
			color: "#fff",
			marginBottom: "8px",
		});
		stopSpeakBtn.title = "Stop speaking (Alt+X)";
		stopSpeakBtn.addEventListener("click", stopSpeaking);
		content.appendChild(stopSpeakBtn);

		// submit
		submitBtn = document.createElement("button");
		submitBtn.textContent = "✅ Submit";
		Object.assign(submitBtn.style, {
			width: "100%",
			padding: "10px",
			borderRadius: "10px",
			border: "none",
			cursor: "pointer",
			background: "#28a745",
			color: "#fff",
		});
		submitBtn.title = "Submit command (Alt+S)";
		content.appendChild(submitBtn);

		function submitCommand() {
			const text = inputEl.value.trim();
			if (!text) return;

			if (text.toLowerCase().includes("diagnose")) {
				pushConvo("user", text);
				diagnose();
			} else {
				runUtterance(text);
			}
			inputEl.value = "";
		}

		submitBtn.addEventListener("click", submitCommand);

		// Enter submits
		inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter") submitCommand();
		});

		// speech recognition init
		const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
		if (!SpeechRecognition) {
			logToast("SpeechRecognition not supported in this browser.");
			micBtn.disabled = true;
			pushConvo("system", "SpeechRecognition not supported in this browser.");
		} else {
			recognizer = new SpeechRecognition();
			recognizer.continuous = false;
			recognizer.interimResults = true;
			recognizer.lang = "en-US";

			micBtn.addEventListener("click", () => {
				if (!listening) {
					try {
						recognizer.start();
					} catch {}
				} else {
					stopListening();
				}
			});

			recognizer.addEventListener("start", () => {
				listening = true;
				micBtn.textContent = "🛑 Stop";
				inputEl.value = "";
				pushConvo("system", "Listening…");
			});

			recognizer.addEventListener("end", () => {
				listening = false;
				micBtn.textContent = "🎤 Listen";
				if (autoSubmitTimer) clearTimeout(autoSubmitTimer);
				autoSubmitTimer = null;
				pushConvo("system", "Stopped listening.");
			});

			recognizer.addEventListener("result", (event) => {
				const transcript = Array.from(event.results)
					.map((r) => r[0].transcript)
					.join("");
				inputEl.value = transcript;

				if (autoSubmitTimer) clearTimeout(autoSubmitTimer);
				autoSubmitTimer = setTimeout(() => {
					submitCommand();
				}, 3000);
			});

			recognizer.addEventListener("speechend", () => stopListening());
		}

		// --- shortcuts ---------------------------------------------------------
		// Alt+L listen/stop, Alt+S submit, Alt+X stop speaking
		// Alt+C copy, Alt+R clear, Alt+H help, Alt+M minimize/show
		// Alt+D diagnose, Alt+F focus input
		document.addEventListener("keydown", (e) => {
			// Don't steal shortcuts while user is typing unless it's Alt+...
			if (!e.altKey) return;

			const k = (e.key || "").toLowerCase();
			if (!k) return;

			// prevent browser alt-menu triggers in some cases
			e.preventDefault();

			if (k === "l") {
				// listen toggle
				if (!recognizer) return;
				if (!listening) {
					try {
						recognizer.start();
					} catch {}
				} else {
					stopListening();
				}
				return;
			}

			if (k === "s") {
				submitCommand();
				return;
			}

			if (k === "x") {
				stopSpeaking();
				return;
			}

			if (k === "c") {
				copyConversation();
				return;
			}

			if (k === "r") {
				clearConversation();
				return;
			}

			if (k === "h") {
				speakHelp();
				return;
			}

			if (k === "m") {
				const minimized = content.style.display !== "none";
				setMinimized(container, content, minimized);
				return;
			}

			if (k === "d") {
				pushConvo("user", "diagnose");
				diagnose();
				return;
			}

			if (k === "f") {
				focusInput();
				return;
			}
		});

		// apply minimized state on load
		setMinimized(container, content, defaultMin);

		document.body.appendChild(container);

		// initial system line only once per session load (don't spam if UI re-injects)
		pushConvo("system", "Convox Test UI ready. Logs persist across pages until you press Clear.");

		// render existing logs
		renderLog();
	}

	// Create UI after DOM
	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", ensureTestUI, { once: true });
	} else {
		ensureTestUI();
	}
})();
