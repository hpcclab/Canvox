// lib/geminiModel.js
// Shared helpers for Gemini Nano (Chrome Prompt API): availability, auto-download, session creation,
// download status tracking, and spoken "not ready" notices.
// Use these from geminiPlanner.js and geminiAnswerer.js so both behave the same way.

const OPTIONS = {
	expectedInputs: [{ type: "text", languages: ["en"] }],
	expectedOutputs: [{ type: "text", languages: ["en"] }],
};

// --- Status tracking ---------------------------------------------------------

let status = { state: "unknown", progress: 0 }; // state: unknown | waiting-for-gesture | downloading | ready
let speakFn = null;
let lastNoticeKey = "";
let lastNoticeAt = 0;

function setStatus(patch) {
	status = { ...status, ...patch };
}

export function getNanoStatus() {
	return { ...status };
}

// Register how Canvox speaks. Call once at startup:
//   setNanoSpeaker((msg) => speak(msg, { mode: "say" }));
export function setNanoSpeaker(fn) {
	speakFn = fn;
}

// Call this right before throwing "not ready". Speaks a short notice, at most once per minute
// per state (and once per page load for "unavailable"), so repeated commands don't repeat it.
// Builds the user-facing sentence for a not-ready state, or null if there's nothing to say.
// Use it to show the same text in the chat window as well as to speak it.
export function getNanoNotReadyMessage(availability) {
	let message;
	if (availability === "downloading") {
		const pct = Math.round((status.progress || 0) * 100);
		message =
			pct > 0
				? `The on-device AI is still downloading, about ${pct} percent done. Basic commands only for now.`
				: "The on-device AI is still downloading. Basic commands only for now.";
	} else if (availability === "downloadable") {
		message = "The on-device AI hasn't been downloaded yet. Press any key to start the download. Basic commands only for now.";
	} else if (availability === "unavailable") {
		message = "The on-device AI can't run on this device, so only basic commands are available.";
	} else {
		return null; // "unsupported" or unknown: stay quiet
	}
	return message;
}

export function notifyNanoNotReady(availability) {
	if (!speakFn) return;
	const message = getNanoNotReadyMessage(availability);
	if (!message) return;

	const interval = availability === "unavailable" ? Infinity : 60_000;
	const now = Date.now();
	if (availability === lastNoticeKey && now - lastNoticeAt < interval) return;

	lastNoticeKey = availability;
	lastNoticeAt = now;
	speakFn(message);
}

// --- Availability ------------------------------------------------------------

// Returns "unsupported" | "unavailable" | "downloadable" | "downloading" | "available"
export async function getNanoAvailability() {
	if (typeof LanguageModel === "undefined") return "unsupported";
	try {
		return await LanguageModel.availability(OPTIONS);
	} catch (e) {
		console.warn("[Canvox] availability() failed:", e);
		return "unsupported";
	}
}

// Chrome only lets a model download START after a user gesture (click, key press).
// Canvox is voice-driven, so wait for the first interaction with the page.
function waitForUserActivation() {
	return new Promise((resolve) => {
		const events = ["pointerdown", "keydown"];
		const done = () => {
			events.forEach((e) => window.removeEventListener(e, done, true));
			resolve();
		};
		events.forEach((e) => window.addEventListener(e, done, true));
	});
}

// --- Session creation --------------------------------------------------------

// Creates a session. If the model isn't on the machine yet, this starts the download
// (waiting for a user gesture first if needed) and resolves once it finishes.
// onStatus receives: { state: "waiting-for-gesture" | "downloading" | "ready", progress?: 0..1 }
// (downloading updates arrive in 25% steps). getNanoStatus() always has the latest exact progress.
// Pass either systemPrompt (a string) or initialPrompts (a full array, e.g. system + few-shot examples).
export async function createNanoSession({ systemPrompt, initialPrompts, onStatus = () => {} } = {}) {
	const availability = await getNanoAvailability();

	if (availability === "unsupported" || availability === "unavailable") {
		throw new Error(`Gemini Nano can't run on this device (${availability}).`);
	}

	const report = (s) => {
		setStatus(s);
		onStatus(s);
	};

	if (availability === "downloadable" && !navigator.userActivation?.isActive) {
		report({ state: "waiting-for-gesture" });
		await waitForUserActivation();
	}

	let lastBucket = -1;
	const session = await LanguageModel.create({
		...OPTIONS,
		...(initialPrompts
			? { initialPrompts }
			: systemPrompt
				? { initialPrompts: [{ role: "system", content: systemPrompt }] }
				: {}),
		monitor(m) {
			m.addEventListener("downloadprogress", (e) => {
				const loaded = e.loaded ?? 0;
				setStatus({ state: "downloading", progress: loaded }); // keep exact progress for on-demand notices

				// Report to onStatus in 25% steps so a screen reader user isn't flooded with updates.
				const bucket = Math.floor(loaded * 4);
				if (bucket !== lastBucket) {
					lastBucket = bucket;
					onStatus({ state: "downloading", progress: loaded });
				}
			});
		},
	});

	report({ state: "ready", progress: 1 });
	return session;
}

// Call once at startup. Starts the download in the background if needed, then discards the session.
// Safe to call every page load: it does nothing if the model is already available.
let warmUpPromise = null;
export function warmUpNano({ onStatus } = {}) {
	if (!warmUpPromise) {
		warmUpPromise = (async () => {
			const availability = await getNanoAvailability();
			if (availability === "available") {
				setStatus({ state: "ready", progress: 1 });
				return availability;
			}
			if (availability === "unsupported" || availability === "unavailable") {
				return availability;
			}
			try {
				const session = await createNanoSession({ onStatus });
				session.destroy?.();
				return "available";
			} catch (e) {
				console.warn("[Canvox] Gemini Nano warm-up failed:", e);
				warmUpPromise = null; // allow a retry later
				return "failed";
			}
		})();
	}
	return warmUpPromise;
}