// lib/geminiModel.js
// Shared helpers for Gemini Nano (Chrome Prompt API): availability, auto-download, session creation.
// Use these from geminiPlanner.js and your answerer so both behave the same way.

const OPTIONS = {
	expectedInputs: [{ type: "text", languages: ["en"] }],
	expectedOutputs: [{ type: "text", languages: ["en"] }],
};

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

// Creates a session. If the model isn't on the machine yet, this starts the download
// (waiting for a user gesture first if needed) and resolves once it finishes.
// onStatus receives: { state: "waiting-for-gesture" | "downloading" | "ready", progress?: 0..1 }
// Pass either systemPrompt (a string) or initialPrompts (a full array, e.g. system + few-shot examples).
export async function createNanoSession({ systemPrompt, initialPrompts, onStatus = () => {} } = {}) {
	const availability = await getNanoAvailability();

	if (availability === "unsupported" || availability === "unavailable") {
		throw new Error(`Gemini Nano can't run on this device (${availability}).`);
	}

	if (availability === "downloadable" && !navigator.userActivation?.isActive) {
		onStatus({ state: "waiting-for-gesture" });
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
				// Report in 25% steps so a screen reader user isn't flooded with updates.
				const bucket = Math.floor((e.loaded ?? 0) * 4);
				if (bucket !== lastBucket) {
					lastBucket = bucket;
					onStatus({ state: "downloading", progress: e.loaded });
				}
			});
		},
	});

	onStatus({ state: "ready" });
	return session;
}

// Call once at startup. Starts the download in the background if needed, then discards the session.
// Safe to call every page load: it does nothing if the model is already available.
let warmUpPromise = null;
export function warmUpNano({ onStatus } = {}) {
	if (!warmUpPromise) {
		warmUpPromise = (async () => {
			const availability = await getNanoAvailability();
			if (availability === "available" || availability === "unsupported" || availability === "unavailable") {
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