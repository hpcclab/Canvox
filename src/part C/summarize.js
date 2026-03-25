// src/part c/summarize.js
"use strict";

"use strict";

// =============================================================================
// Page summarization helpers
//
// Goals:
// - Produce a concise, accurate summary of on-screen text.
// - Prefer Chrome's on-device Summarizer API (Gemini Nano) when available.
//   This keeps the extension lightweight (no bundled model) and can work offline
//   after the model is downloaded by the browser.
// - Fall back to a fast heuristic extractive summary when the API isn't available.
//
// References:
// - Chrome Summarizer API docs (feature detection, availability, create, summarize)
//   https://developer.chrome.com/docs/ai/summarizer-api
// =============================================================================

// Cache a single summarizer session to avoid recreating it on every command.
// Creating sessions can be slower than summarizing.
let _summarizerSession = null;
let _summarizerSessionKey = "";

// A tiny English stopword list for the heuristic fallback.
// (We keep it small for performance and to avoid shipping large lists.)
const STOPWORDS = new Set([
	"a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "has", "have", "he", "her", "his", "i", "if", "in", "into", "is", "it", "its", "me", "my", "not", "of", "on", "or", "our", "she", "so", "that", "the", "their", "them", "then", "there", "these", "they", "this", "to", "us", "was", "we", "were", "what", "when", "where", "which", "who", "will", "with", "you", "your",
]);

function clamp(n, lo, hi) {
	return Math.max(lo, Math.min(hi, n));
}

function splitSentences(text) {
	return text
		.replace(/\s+/g, " ")
		.split(/(?<=[.!?])\s+/)
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * Quick summary: naive but effective –
 * take first N non-trivial sentences.
 */
export function quickSummary(text, maxSentences = 3) {
	const sentences = splitSentences(text);
	const filtered = sentences.filter((s) => s.length > 20); // skip very short bits
	return filtered.slice(0, maxSentences).join(" ");
}

/**
 * Chunk long text for TTS, roughly by character limit.
 * You can tweak maxChars based on how long you want each spoken piece to be.
 */
function stripUrls(text) {
	return String(text || "")
		.replace(/https?:\/\/\S+/gi, "")
		.replace(/\s+\)/g, ")");
}

function stripBoilerplate(text) {
	const lines = String(text || "")
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);

	const out = [];
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i];
		const low = l.toLowerCase();

		if (/^(dear|hi|hello)\b/.test(low)) continue;

		if (/^(sincerely|best regards|regards|thank you|thanks),?$/.test(low)) {
			break;
		}

		if (/\bta\b|\bteaching assistant\b|\bprof\b|\binstructor\b/.test(low) && l.length < 80) {
			continue;
		}

		if (/links to an external site\.?$/i.test(l)) continue;

		out.push(l);
	}

	return out.join("\n");
}

function cleanInputText(raw) {
	let t = String(raw || "");
	t = stripUrls(t);
	t = stripBoilerplate(t);
	t = t.replace(/\s+/g, " ").trim();
	const MAX_INPUT_CHARS = 20000;
	if (t.length > MAX_INPUT_CHARS) t = t.slice(0, MAX_INPUT_CHARS);
	return t;
}

function normalizeOutput(summary) {
	let s = String(summary || "").trim();
	if (!s) return "";

	if (/^\s*[-*]\s+/m.test(s)) {
		const lines = s
			.split(/\r?\n/)
			.map((l) => l.replace(/^\s*[-*]\s+/, "").trim())
			.filter(Boolean);
		s = lines.join(". ");
	}

	s = s.replace(/\s+/g, " ").trim();
	if (!/[.!?]$/.test(s)) s += ".";
	return s;
}

function takeFirstNSentences(text, n) {
	const sentences = splitSentences(text);
	if (sentences.length <= n) return sentences.join(" ");
	return sentences.slice(0, n).join(" ");
}

function heuristicExtractiveSummary(text, maxSentences = 2) {
	const sentences = splitSentences(text)
		.map((s) => s.trim())
		.filter((s) => s.length > 25);

	if (!sentences.length) return "";

	const MAX_SENTENCES = 200;
	const pool = sentences.slice(0, MAX_SENTENCES);

	const freq = new Map();
	for (const s of pool) {
		const words = s
			.toLowerCase()
			.replace(/[^a-z0-9\s]/g, " ")
			.split(/\s+/)
			.filter(Boolean)
			.filter((w) => w.length > 2 && !STOPWORDS.has(w));

		for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);
	}

	const scored = pool.map((s, idx) => {
		const words = s
			.toLowerCase()
			.replace(/[^a-z0-9\s]/g, " ")
			.split(/\s+/)
			.filter(Boolean)
			.filter((w) => w.length > 2 && !STOPWORDS.has(w));

		let score = 0;
		for (const w of words) score += freq.get(w) || 0;
		score = score / Math.sqrt(Math.max(1, words.length));

		if (/\b(register|attend|due|bonus|credit|grade|deadline|meeting|location|room|zoom)\b/i.test(s)) {
			score *= 1.15;
		}
		return { s, idx, score };
	});

	scored.sort((a, b) => b.score - a.score);
	const top = scored
		.slice(0, clamp(maxSentences, 1, 5))
		.sort((a, b) => a.idx - b.idx);
	return top.map((x) => x.s).join(" ");
}

async function getSummarizerSession(options) {
	if (!("Summarizer" in self)) return null;

	const key = JSON.stringify({
		type: options?.type,
		length: options?.length,
		format: options?.format,
		outputLanguage: options?.outputLanguage,
		expectedInputLanguages: options?.expectedInputLanguages,
	});

	if (_summarizerSession && _summarizerSessionKey === key) return _summarizerSession;

	const availability = await Summarizer.availability();
	if (availability === "unavailable") return null;

	if (!navigator?.userActivation?.isActive) return null;

	try {
		_summarizerSession = await Summarizer.create({
			...options,
			monitor(m) {
				try {
					m.addEventListener("downloadprogress", () => { });
				} catch { }
			},
		});
		_summarizerSessionKey = key;
		return _summarizerSession;
	} catch (e) {
		console.warn("Failed to create Summarizer session:", e);
		_summarizerSession = null;
		_summarizerSessionKey = "";
		return null;
	}
}

export async function quickSummary(text, maxSentences = 2) {
	const cleaned = cleanInputText(text);
	if (!cleaned) return "";

	if (cleaned.length < 220) {
		return normalizeOutput(cleaned);
	}

	try {
		const session = await getSummarizerSession({
			type: "tldr",
			length: "medium",
			format: "plain-text",
			expectedInputLanguages: ["en"],
			outputLanguage: "en",
			sharedContext:
				"Summarize the page content for a student. Focus on the main request, important dates/locations, and incentives (like bonus grades). Omit greetings, signatures, and URLs.",
		});

		if (session) {
			const raw = await session.summarize(cleaned, {
				context:
					"Return a concise, actionable summary. Keep it to about 2 sentences. Include key date/location and any rewards or next steps.",
			});
			const normalized = normalizeOutput(raw);
			return normalizeOutput(takeFirstNSentences(normalized, clamp(maxSentences, 1, 3)));
		}
	} catch (e) {
		console.warn("Summarizer API failed; falling back to heuristic summary:", e);
	}

	const fallback = heuristicExtractiveSummary(cleaned, clamp(maxSentences, 1, 3));
	return normalizeOutput(fallback);
}

export function chunkForReading(text, maxChars = 800) {
	const sentences = splitSentences(text);
	const chunks = [];
	let current = "";

	for (const s of sentences) {
		if (!current) {
			current = s;
		} else if ((current + " " + s).length <= maxChars) {
			current += " " + s;
		} else {
			chunks.push(current);
			current = s;
		}
	}
	if (current) chunks.push(current);
	return chunks;
}
