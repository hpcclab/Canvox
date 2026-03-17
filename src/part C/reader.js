// src/part c/reader.js
"use strict";

import { getPageContext } from "./domctx.js";
import { quickSummary, chunkForReading } from "./summarize.js";
import { textToSpeech } from "../model/tts.js"; // you already use this elsewhere

let lastContext = null;
let currentSectionIndex = 0;

function ensureContext(forceRefresh = false) {
	if (!lastContext || forceRefresh) {
		lastContext = getPageContext();
		currentSectionIndex = 0;
	}
	return lastContext;
}

/**
 * Read a short, 3-ish sentence summary of the most important text on the page.
 * Intended for commands like "give me a quick summary" or "what's this about?"
 */
export function readQuickSummary(recognitionState, { refresh = false } = {}) {
	const ctx = ensureContext(refresh);

	let baseText = "";
	if (ctx.sections.length > 0) {
		baseText = ctx.sections[0].text;
	} else if (ctx.rawHtml) {
		baseText = ctx.rawHtml.replace(/<[^>]+>/g, " ");
	}

	if (!baseText) {
		textToSpeech("I couldn't find anything to summarize on this page.", recognitionState);
		return;
	}

	const summary = quickSummary(baseText);
	let prefix = "";

	if (ctx.type === "assignment") {
		const title = ctx.title || "this assignment";
		prefix = `Here's a quick summary of ${title}. `;
		if (ctx.dueDate) {
			prefix += `It is due ${ctx.dueDate}. `;
		}
	} else if (ctx.title) {
		prefix = `Here's a quick summary of ${ctx.title}. `;
	}

	textToSpeech(prefix + summary, recognitionState);
}

/**
 * Read the entire main section of the page, chunked into smaller TTS-friendly pieces.
 * Intended for "read the whole assignment" or "read this page".
 */
export function readFull(recognitionState, { refresh = false } = {}) {
	const ctx = ensureContext(refresh);

	if (!ctx.sections.length) {
		textToSpeech("I couldn't find any readable content on this page.", recognitionState);
		return;
	}

	currentSectionIndex = 0;
	readCurrentSection(recognitionState);
}

/**
 * Read only the due date, if present.
 * Intended for "when is this due?"
 */
export function readDueDate(recognitionState, { refresh = false } = {}) {
	const ctx = ensureContext(refresh);

	if (ctx.type === "assignment" && ctx.dueDate) {
		textToSpeech(`This assignment is due ${ctx.dueDate}.`, recognitionState);
	} else {
		textToSpeech("I couldn't find a due date on this page.", recognitionState);
	}
}

/**
 * Read the currently-selected section (instructions, rubric, etc.)
 */
export function readCurrentSection(recognitionState, { headingPrefix = true } = {}) {
	const ctx = ensureContext();

	const section = ctx.sections[currentSectionIndex];
	if (!section) {
		textToSpeech("There is no content in this section.", recognitionState);
		return;
	}

	const chunks = chunkForReading(section.text);

	// For now, we'll just read the first chunk. You can later extend this
	// to read all chunks in sequence using callbacks or events.
	let text = "";
	if (headingPrefix && section.heading) {
		text += `${section.heading}. `;
	}
	text += chunks[0];

	textToSpeech(text, recognitionState);
}

/**
 * Move to next section and read it.
 * Intended for "next section" or "next part".
 */
export function readNextSection(recognitionState) {
	const ctx = ensureContext();

	if (currentSectionIndex < ctx.sections.length - 1) {
		currentSectionIndex++;
		readCurrentSection(recognitionState);
	} else {
		textToSpeech("There is no next section.", recognitionState);
	}
}

/**
 * Move to previous section and read it.
 * Intended for "previous section" or "go back a bit".
 */
export function readPreviousSection(recognitionState) {
	const ctx = ensureContext();

	if (currentSectionIndex > 0) {
		currentSectionIndex--;
		readCurrentSection(recognitionState);
	} else {
		textToSpeech("You are already at the first section.", recognitionState);
	}
}

/**
 * Optional helper: force context refresh (e.g., after navigation)
 */
export function refreshContentContext() {
	ensureContext(true);
}
