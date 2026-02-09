// src/part c/summarize.js
"use strict";

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
