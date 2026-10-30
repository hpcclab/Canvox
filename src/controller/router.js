"use strict";

import { wasATextAction } from "../model/text.js";
import { wasAnInboxAction } from "./inbox.js";
import { POSSIBLE_SIDEBAR_DESTINATIONS, sidebarActionsRouter } from "../model/sidebar.js";
import { collectUniqueDestinations, navigate } from "../model/navigation.js";
import { textToSpeech } from "../model/tts.js";

import {
	quickSummaryCommand,
	readFullCommand,
	dueDateCommand,
	nextSectionCommand,
	prevSectionCommand,
	submitAssignmentCommand,
} from "../part c/reader.js";

import { createGeminiPlanner } from "../model/geminiPlanner.js"; //importing the gemini nano route

let geminiPlannerPromise = null;
async function getGeminiPlanner() {
	if (!geminiPlannerPromise) {
		geminiPlannerPromise = createGeminiPlanner().catch((error) => {
			geminiPlannerPromise = null;
			throw error;
		});
	}

	return geminiPlannerPromise;
}

/**
 * Collects a lightweight snapshot of the current Canvas page for Gemini Nano.
 * Includes the page title, URL path, visible headings, and a limited list of
 * links to provide context for interpreting user commands without passing the
 * entire page HTML to the model.
 */

function getVisiblePageContext() {
	const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
		.filter((element) => element.innerText.trim())
		.map((element) => element.innerText.trim())
		.slice(0, 10);

	const links = Array.from(document.querySelectorAll("a"))
		.filter((element) => element.innerText.trim())
		.map((element) => ({
			text: element.innerText.trim(),
			href: element.getAttribute("href") || "",
		}))
		.slice(0, 30);

	return JSON.stringify({
		pageTitle: document.title,
		pageUrl: location.pathname,
		headings,
		links,
	});
}

export async function route(transcript, recognitionState) {
	if (!transcript || !transcript.trim()) return;

	const command = transcript.trim();
	const t = command.toLowerCase();
	console.log("[Canvox] Router received command:", command);

	// Part C page-reading commands
	if (t.includes("submit assignment")) {
		await submitAssignmentCommand(recognitionState);
		return;
	}

	if (t.includes("summarize") || t.includes("summary")) {
		await quickSummaryCommand(recognitionState);
		return;
	}

	if (t.includes("read full")) {
		await readFullCommand(recognitionState);
		return;
	}

	if (t.includes("due date")) {
		await dueDateCommand(recognitionState);
		return;
	}

	if (t.includes("next section")) {
		await nextSectionCommand(recognitionState);
		return;
	}

	if (t.includes("previous section") || t.includes("prev section")) {
		await prevSectionCommand(recognitionState);
		return;
	}

	// Existing discussion text actions
	if (wasATextAction(command, recognitionState)) {
		return;
	}

	// Existing inbox actions
	if (wasAnInboxAction(command, recognitionState)) {
		return;
	}

	// Common Canvas sidebar destinations
	const sidebarDestination = POSSIBLE_SIDEBAR_DESTINATIONS.find(
		(destination) =>
			t === destination ||
			t === `open ${destination}` ||
			t === `go to ${destination}` ||
			t === `navigate to ${destination}` ||
			t === `show ${destination}`,
	);

	if (sidebarDestination) {
		if (sidebarActionsRouter(sidebarDestination)) {
			return;
		}
	}

	// Other destinations on the current Canvas page
	const destinations = collectUniqueDestinations();
	const matchedDestination = destinations
		.filter((destination) => t.includes(destination.toLowerCase()))
		.sort((a, b) => b.length - a.length)[0];

	if (matchedDestination && navigate(matchedDestination)) {
		return;
	}

	//textToSpeech(
	//    `Sorry, I did not understand "${command}".`,
	//    recognitionState,
	//);

	// Use Gemini Nano as a fallback for commands not handled by existing rules
	try {
		const planner = await getGeminiPlanner();
		const pageContext = getVisiblePageContext();
		const plan = await planner.plan(command, pageContext);

		console.log("[Canvox] Gemini Nano plan:", plan);

		if (plan.intent === "clarify" && plan.clarification) {
			textToSpeech(plan.clarification, recognitionState);
			return;
		}

		// Planning only for now; do not execute model-generated actions yet.
		const summary = plan.steps.map((step) => `${step.action}: ${step.target}`).join(". ");

		if (summary) {
			textToSpeech(`I understood your request. My plan is: ${summary}`, recognitionState);
			return;
		}
	} catch (error) {
		console.error("[Canvox] Gemini Nano fallback failed:", error);
	}

	// Preserve the original response if planning fails or returns no steps
	textToSpeech(`Sorry, I did not understand "${command}".`, recognitionState);
}

export async function routeActions(transcript, recognitionState) {
	return route(transcript, recognitionState);
}
