// content_test.js
// Person B test harness with floating button + auto-recovery for "Extension context invalidated".

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
			// If the extension was reloaded/updated, the old content script is stale.
			if (msg.includes("Extension context invalidated")) {
				logToast("Detected invalidated context. Attempting one-time page reload to re-inject content script.");
				if (!reloadedOnce) {
					reloadedOnce = true;
					alert("Convox was just reloaded. I’ll refresh this page once so testing can continue.");
					location.reload(); // re-injects the content script
				}
				throw err; // stop current action; user will retry after refresh
			}
			throw err;
		}
	}

	async function runUtterance(text) {
		const { handleUtterance } = await safeImportActions();
		const out = await handleUtterance(text);
		logToast(out);
	}

	// --- hotkey (Cmd/Ctrl/Option + K) -----------------------------------------
	document.addEventListener("keydown", async (e) => {
		try {
			if ((e.metaKey || e.ctrlKey || e.altKey) && e.key.toLowerCase() === "k") {
				e.preventDefault();
				await openPrompt();
			}
		} catch (err) {
			console.warn("[Convox Test] hotkey handler error:", err);
		}
	});

	// --- floating button -------------------------------------------------------
	function ensureTestButton() {
		if (document.getElementById("convox-test-btn")) return;
		const btn = document.createElement("button");
		btn.id = "convox-test-btn";
		btn.type = "button";
		btn.title = "Convox Test (click to enter a command)";
		btn.setAttribute("aria-label", "Convox Test. Click to enter a command.");
		Object.assign(btn.style, {
			position: "fixed",
			bottom: "16px",
			right: "16px",
			zIndex: "2147483647",
			fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
			fontSize: "14px",
			lineHeight: "1",
			padding: "10px 12px",
			borderRadius: "12px",
			border: "1px solid rgba(0,0,0,0.2)",
			boxShadow: "0 2px 10px rgba(0,0,0,0.25)",
			background: "#111",
			color: "#fff",
			cursor: "pointer",
			opacity: "0.92",
		});
		btn.textContent = "Convox Test 🔊";
		btn.addEventListener("mouseenter", () => {
			btn.style.opacity = "1";
		});
		btn.addEventListener("mouseleave", () => {
			btn.style.opacity = "0.92";
		});
		btn.addEventListener("click", openPrompt);
		btn.addEventListener("keydown", (e) => {
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				btn.click();
			}
		});
		document.body.appendChild(btn);
	}

	async function openPrompt() {
		const text = prompt(
			"Convox (Person B test): type a command\n" +
				"Examples: open my grades | open assignments | read the page | read the next part | help\n" +
				"Type 'diagnose convox' for a quick self-test",
		);
		if (!text) return;
		const t = text.trim().toLowerCase();
		if (t.includes("diagnose")) {
			await diagnose();
			return;
		}
		await runUtterance(text);
	}

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", ensureTestButton, { once: true });
	} else {
		ensureTestButton();
	}

	// on-load voice cue
	try {
		const { speak } = await safeImportActions();
		speak("Convox test harness loaded. Press Command K or click the Convox Test button to try a command.");
	} catch (e) {
		// If we hit invalidated context here, the auto-reload will trigger on first interaction.
	}
	logToast("Loaded. Press Cmd/Ctrl/Option + K or click the Convox Test 🔊 button to test Person B.");
})();
