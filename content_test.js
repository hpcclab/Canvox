// content_test.js
(async () => {
	// --- helpers ---------------------------------------------------------------
	function logToast(msg, ...rest) {
		console.log("[Convox Test]", msg, ...rest);
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
		const out = await handleUtterance(text);
		logToast(out);
	}

	// --- prompt + speech UI ---------------------------------------------------
	function ensureTestUI() {
		if (document.getElementById("convox-test-container")) return;

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
			width: "250px",
		});

		const header = document.createElement("div");
		header.textContent = "Convox Test 🔊";
		header.style.cursor = "pointer";
		header.style.fontWeight = "bold";
		container.appendChild(header);

		const content = document.createElement("div");
		content.style.marginTop = "8px";
		container.appendChild(content);

		// text input
		const input = document.createElement("input");
		input.type = "text";
		input.placeholder = "Type a command or use mic 🎤";
		Object.assign(input.style, {
			width: "100%",
			padding: "6px",
			borderRadius: "6px",
			border: "none",
			marginBottom: "6px",
		});
		content.appendChild(input);

		// mic button
		const micBtn = document.createElement("button");
		micBtn.textContent = "🎤 Listen";
		Object.assign(micBtn.style, {
			width: "100%",
			padding: "6px",
			borderRadius: "6px",
			border: "none",
			cursor: "pointer",
			background: "#444",
			color: "#fff",
			marginBottom: "6px",
		});
		content.appendChild(micBtn);

		// submit button
		const submitBtn = document.createElement("button");
		submitBtn.textContent = "✅ Submit";
		Object.assign(submitBtn.style, {
			width: "100%",
			padding: "6px",
			borderRadius: "6px",
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

		// --- speech recognition ---
		const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
		if (!SpeechRecognition) {
			logToast("SpeechRecognition not supported in this browser.");
			micBtn.disabled = true;
			return;
		}
		const recognizer = new SpeechRecognition();
		recognizer.continuous = false;
		recognizer.interimResults = true;
		recognizer.lang = "en-US";

		let listening = false;
		let autoSubmitTimer = null;

		// --- hotkey: Cmd/Ctrl + P to toggle listening ---
		document.addEventListener("keydown", (e) => {
			try {
				if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "p") {
					e.preventDefault();
					if (!listening) {
						recognizer.start();
					} else {
						recognizer.stop();
					}
				}
			} catch (err) {
				console.warn("[Convox Test] hotkey error:", err);
			}
		});

		micBtn.addEventListener("click", () => {
			if (!listening) {
				recognizer.start();
			} else {
				recognizer.stop();
			}
		});

		recognizer.addEventListener("start", () => {
			listening = true;
			micBtn.textContent = "🛑 Stop";
			input.value = "";
		});

		recognizer.addEventListener("end", () => {
			listening = false;
			micBtn.textContent = "🎤 Listen";
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
			recognizer.stop();
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
