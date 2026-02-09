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

  if (t.includes("summary")) {
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
