// content_test.js
(async () => {
	// --- helpers ---------------------------------------------------------------
	function logToast(msg, ...rest) {
		console.log("[Convox Test]", msg, ...rest);
	}

	// ---- conversation transcript ---------------------------------------------
	const convo = []; // { role: "user"|"convox"|"system", text, ts }
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
			} catch (e) {
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
		} catch (e) {
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
		const { handleUtterance } = await safeImportActions();

		pushConvo("user", text);

		const out = await handleUtterance(text);
		logToast(out);

		// We don't force-log "result" text (Convox speaks via TTS and we capture that),
		// but we log intent for debugging + transparency.
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
	let copyBtn = null;
	let clearBtn = null;

	function renderLog() {
		if (!logEl) return;
		const txt = convoToText();
		logEl.value = txt;
		// keep scrolled to bottom
		try {
			logEl.scrollTop = logEl.scrollHeight;
		} catch {}
		// update copy button label briefly (optional)
	}

	async function copyConversation() {
		const txt = convoToText();
		try {
			await navigator.clipboard.writeText(txt);
			pushConvo("system", "Conversation copied to clipboard.");
		} catch {
			// fallback
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
		convo.length = 0;
		pushConvo("system", "Conversation cleared.");
		renderLog();
	}

	function stopSpeaking() {
		try {
			window.speechSynthesis?.cancel?.();
			pushConvo("system", "Stopped speaking.");
		} catch {
			// ignore
		}
	}

	function ensureTestUI() {
		if (document.getElementById("convox-test-container")) return;

		patchTTSOnce();

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
			width: "320px",
		});

		const header = document.createElement("div");
		header.textContent = "Convox Test 🔊";
		header.style.cursor = "pointer";
		header.style.fontWeight = "bold";
		container.appendChild(header);

		const content = document.createElement("div");
		content.style.marginTop = "8px";
		container.appendChild(content);

		// transcript (text form)
		logEl = document.createElement("textarea");
		logEl.id = "convox-test-log";
		logEl.readOnly = true;
		logEl.placeholder = "Conversation transcript will appear here…";
		Object.assign(logEl.style, {
			width: "100%",
			height: "140px",
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

		// row: copy / clear
		const row1 = document.createElement("div");
		Object.assign(row1.style, { display: "flex", gap: "6px", marginBottom: "8px" });
		content.appendChild(row1);

		copyBtn = document.createElement("button");
		copyBtn.textContent = "📋 Copy";
		Object.assign(copyBtn.style, {
			flex: "1",
			padding: "6px",
			borderRadius: "6px",
			border: "none",
			cursor: "pointer",
			background: "#444",
			color: "#fff",
		});
		copyBtn.addEventListener("click", copyConversation);
		row1.appendChild(copyBtn);

		clearBtn = document.createElement("button");
		clearBtn.textContent = "🧹 Clear";
		Object.assign(clearBtn.style, {
			flex: "1",
			padding: "6px",
			borderRadius: "6px",
			border: "none",
			cursor: "pointer",
			background: "#444",
			color: "#fff",
		});
		clearBtn.addEventListener("click", clearConversation);
		row1.appendChild(clearBtn);

		// text input
		const input = document.createElement("input");
		input.type = "text";
		input.placeholder = "Type a command or use mic 🎤";
		Object.assign(input.style, {
			width: "100%",
			padding: "8px",
			borderRadius: "8px",
			border: "none",
			marginBottom: "8px",
		});
		content.appendChild(input);

		// mic button
		const micBtn = document.createElement("button");
		micBtn.textContent = "🎤 Listen";
		Object.assign(micBtn.style, {
			width: "100%",
			padding: "8px",
			borderRadius: "8px",
			border: "none",
			cursor: "pointer",
			background: "#444",
			color: "#fff",
			marginBottom: "8px",
		});
		content.appendChild(micBtn);

		// STOP SPEAKING button (what you asked for)
		const stopSpeakBtn = document.createElement("button");
		stopSpeakBtn.textContent = "🛑 Stop speaking";
		Object.assign(stopSpeakBtn.style, {
			width: "100%",
			padding: "8px",
			borderRadius: "8px",
			border: "none",
			cursor: "pointer",
			background: "#b00020",
			color: "#fff",
			marginBottom: "8px",
		});
		stopSpeakBtn.addEventListener("click", () => {
			stopSpeaking();
		});
		content.appendChild(stopSpeakBtn);

		// submit button
		const submitBtn = document.createElement("button");
		submitBtn.textContent = "✅ Submit";
		Object.assign(submitBtn.style, {
			width: "100%",
			padding: "8px",
			borderRadius: "8px",
			border: "none",
			cursor: "pointer",
			background: "#28a745",
			color: "#fff",
		});
		content.appendChild(submitBtn);

		function submitCommand() {
			const text = input.value.trim();
			if (!text) return;

			if (text.toLowerCase().includes("diagnose")) {
				pushConvo("user", text);
				diagnose();
			} else {
				runUtterance(text);
			}
			input.value = "";
		}

		submitBtn.addEventListener("click", submitCommand);

		// collapse toggle
		let collapsed = false;
		header.addEventListener("click", () => {
			collapsed = !collapsed;
			content.style.display = collapsed ? "none" : "block";
		});

		document.body.appendChild(container);

		// initial log line
		pushConvo("system", "Convox Test UI ready. Your commands + Convox speech will be logged here.");

		// --- speech recognition ---
		const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
		if (!SpeechRecognition) {
			logToast("SpeechRecognition not supported in this browser.");
			micBtn.disabled = true;
			pushConvo("system", "SpeechRecognition not supported in this browser.");
			return;
		}

		const recognizer = new SpeechRecognition();
		recognizer.continuous = false;
		recognizer.interimResults = true;
		recognizer.lang = "en-US";

		let listening = false;
		let autoSubmitTimer = null;

		function stopListening() {
			try {
				recognizer.stop();
			} catch {}
		}

		// --- hotkey: Cmd/Ctrl + P to toggle listening ---
		document.addEventListener("keydown", (e) => {
			try {
				if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "p") {
					e.preventDefault();
					if (!listening) recognizer.start();
					else stopListening();
				}
			} catch (err) {
				console.warn("[Convox Test] hotkey error:", err);
			}
		});

		micBtn.addEventListener("click", () => {
			if (!listening) recognizer.start();
			else stopListening();
		});

		recognizer.addEventListener("start", () => {
			listening = true;
			micBtn.textContent = "🛑 Stop";
			input.value = "";
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
			input.value = transcript;

			// reset auto-submit timer
			if (autoSubmitTimer) clearTimeout(autoSubmitTimer);
			autoSubmitTimer = setTimeout(() => {
				submitCommand();
			}, 3000); // 3 seconds of silence
		});

		recognizer.addEventListener("speechend", () => {
			stopListening();
		});

		// handle enter key
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") submitCommand();
		});
	}

	// --- hotkey (Cmd/Ctrl/Option + K) -----------------------------------------
	document.addEventListener("keydown", async (e) => {
		try {
			if ((e.metaKey || e.ctrlKey || e.altKey) && e.key.toLowerCase() === "k") {
				e.preventDefault();
				const input = document.querySelector("#convox-test-container input");
				if (input) input.focus();
			}
		} catch (err) {
			console.warn("[Convox Test] hotkey handler error:", err);
		}
	});

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", ensureTestUI, { once: true });
	} else {
		ensureTestUI();
	}
})();
