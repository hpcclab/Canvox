import { extractDestinations } from "../model/destination.js";
import { extractTextActions } from "../model/text_action.js";
import { extractInboxActions } from "../model/inbox_action.js";
import { narrate } from "./narrate.js";
import { navigate } from "./navigate.js";

// Part C imports
import {
  quickSummaryCommand,
  readFullCommand,
  dueDateCommand,
  nextSectionCommand,
  prevSectionCommand,
  submitAssignmentCommand
} from "../part c/reader.js";

export async function route(transcript, pageContext) {
  if (!transcript || transcript.trim() === "") return;

  const t = transcript.toLowerCase();

  // =====================
  // PART C COMMANDS
  // =====================

  if (t.includes("submit assignment")) {
		await submitAssignmentCommand(pageContext);
    return;
  }

	// Trigger on: "summarize", "summarize page", "summarize this", and "summary"
	// (The intent layer in /lib can be more sophisticated, but this keeps Part C
	// commands working from both typed input and speech.)
	if (t.includes("summarize") || t.includes("summary")) {
		await quickSummaryCommand(pageContext);
    return;
  }

  if (t.includes("read full")) {
    await readFullCommand(pageContext);
    return;
  }

  if (t.includes("due date")) {
    await dueDateCommand(pageContext);
    return;
  }

  if (t.includes("next section")) {
    await nextSectionCommand(pageContext);
    return;
  }

  if (t.includes("previous section") || t.includes("prev section")) {
    await prevSectionCommand(pageContext);
    return;
  }

  // =====================
  // DEFAULT CANVOX ROUTING
  // =====================

  const textActions = extractTextActions(transcript);
  if (textActions.length > 0) {
    narrate(textActions);
    return;
  }

  const inboxActions = extractInboxActions(transcript);
  if (inboxActions.length > 0) {
    narrate(inboxActions);
    return;
  }

  const destinations = extractDestinations(transcript);
  if (destinations.length > 0) {
    navigate(destinations[0]);
    return;
  }

  narrate(`Sorry, I did not understand "${transcript}"`);
}

// =============================================================================
// Primary entrypoint used by SpeechRecognition and typed input.
//
// Historically, this file exported `route()` with a different signature.
// Other modules currently import `routeActions()`. We provide it here to keep
// everything wired together without removing older code.
// =============================================================================

export async function routeActions(transcript, recognitionState) {
	// For the Part C reader commands, we want the recognitionState so TTS can play.
	// The older route() signature expects `pageContext`, and our Part C wrappers
	// accept the recognitionState directly.
	return route(transcript, recognitionState);
}
