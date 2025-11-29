import { useGPT } from "../model/gpt.js";
import { navigate } from "../model/navigation.js";
import { extensionActionRouter } from "../model/settings.js";
import { sidebarActionsRouter } from "../model/sidebar.js";
import { wasATextAction } from "../model/text.js";
import { narratePage } from "../model/tts.js";
import { wasAnInboxAction } from "./inbox.js";
import { loginPageAction, onLoginPage } from "./login.js";

function trySubmitCurrentAssignment() {
	function normalize(text) {
		return (text || "").replace(/\s+/g, " ").trim().toLowerCase();
	}

	function isVisible(el) {
		const style = window.getComputedStyle(el);
		const rect = el.getBoundingClientRect();
		return (
			style.display !== "none" &&
			style.visibility !== "hidden" &&
			rect.width > 0 &&
			rect.height > 0
		);
	}

	try {
		//1)Attribute-based selectors for the main assignment submit button
		const attrSelectors = [
			'[data-testid="assignment-submit-button"]',
			'[data-testid="assignment-student-header-submit-button"]',
			"#submit_assignment",
			".submit_assignment_link",
			'button[type="submit"]',
			'input[type="submit"]',
		];

		for (const sel of attrSelectors) {
			const btn = document.querySelector(sel);
			if (btn && isVisible(btn)) {
				console.log("Canvox: clicking assignment submit button via selector:", sel);
				btn.click();
				return true;
			}
		}

		//2) Fallback: match ONLY “submit assignment”-style text, not any “submit”
		const candidates = Array.from(
			document.querySelectorAll(
				'button, a, [role="button"], input[type="submit"], div[role="button"]'
			)
		);

		const targetPhrases = [
			"submit assignment",
			"resubmit assignment",
			"start assignment",  
			"submit quiz",
		];

		for (const el of candidates) {
			if (!isVisible(el)) continue;

			const label =
				normalize(el.textContent) ||
				normalize(el.getAttribute("aria-label")) ||
				normalize(el.value);

			if (!label) continue;

			for (const phrase of targetPhrases) {
				if (label.includes(phrase)) {
					console.log("Canvox: clicking assignment submit button via text match:", label);
					el.click();
					return true;
				}
			}
		}

		console.warn(
			"Canvox: submit assignment requested but submit button was not found on this page."
		);
		return false;
	} catch (err) {
		console.error("Canvox: error while trying to submit assignment:", err);
		return false;
	}
}



async function routeActions(transcript, recognitionState) {
	if (onLoginPage()) {
		await loginPageAction(transcript, recognitionState);
		return;
	}

	    //for submit assignment command
    if (/submit\s+(the\s+)?assignment\b/i.test(transcript)) {
		const ok = trySubmitCurrentAssignment();
		//We return either way to STOP this from going into navigation logic.
		return;
	}


	//check for text actions first
	if (wasATextAction(transcript, recognitionState)) return;

	if (wasAnInboxAction(transcript, recognitionState)) return;

	const destination = extractDestination(transcript);

	// Handles narration requests
	if (destination === "narrate") {
		narratePage(transcript, recognitionState);
		return;
	}

	// Handles navigation requests
	if (destination) {
		// Check if the destination is a sidebar action
		const wasASidebarAction = sidebarActionsRouter(destination);
		if (wasASidebarAction) {
			// Store the confirmation message in sessionStorage
			sessionStorage.setItem(
				"canvoxNavigation",
				JSON.stringify({
					message: `Opened ${destination}`,
					timestamp: Date.now(),
				}),
			);
			return;
		}
		if (/(micmute|volume.*|toggletranscript)/i.test(destination)) {
			// If the destination is related to microphone, volume, or transcript, trigger the action directly
			// Call the extension action router to handle specific actions'
			extensionActionRouter(destination, recognitionState);
			return;
		}

		const navigationSuccessful = navigate(destination);
		if (!navigationSuccessful) {
			// 	// Only call useGPT if navigation failed
			useGPT(transcript, recognitionState);
		}
	} else {
		// No destination was found, use GPT to interpret
		useGPT(transcript, recognitionState);
	}
}

// This function uses RegEx to extract a destination from the user's voice input. It looks for various patterns that indicate what the user wants to do, such as "go to", "show me", "click", etc. If it finds a match, it cleans up the extracted text and returns it as the destination. If no match is found, it returns undefined.
function extractDestination(transcript) {
	// Pattern 1: Direct commands - "go to X", "open X", etc.
	const directCommands =
		/(?:go(?:\s+to)?|open|show(?:\s+me)?|navigate\s+to|take\s+me\s+to|view|access|display)(?:\s+my)?\s+([a-z0-9\s]+?)(?:\s+course(?:s)?)?$/i;
	// Pattern 2: Question forms - "where are my X?", etc.
	const questionForms =
		/(?:where\s+(?:are|is)(?:\s+my)?|can\s+I\s+see(?:\s+my)?|how\s+do\s+I\s+get\s+to(?:\s+my)?)\s+([a-z0-9\s]+)/i;
	// Pattern 3: Specific needs - "show all my X", etc.
	const specificNeeds =
		/(?:show\s+(?:all|my)(?:\s+my)?|list\s+my(?:\s+current)?|display\s+my(?:\s+enrolled)?|find\s+my)\s+([a-z0-9\s]+)/i;
	// Pattern 4: Context navigation - "return to X" etc.
	const contextNavigation = /(?:return\s+to|back\s+to|switch\s+to|change\s+to|go\s+back(?:\s+to)?)\s+([a-z0-9\s]+|$)/i;
	// Pattern 5: Conversational - "I need to see my X", etc.
	const conversationalPhrases =
		/(?:I\s+(?:need|want)\s+to\s+(?:see|check)(?:\s+my)?|let\s+me\s+see(?:\s+what)?|show\s+me\s+what(?:\s+I'm)?)\s+([a-z0-9\s]+)/i;
	// Pattern 6: Click/Press actions - "click X", "press X", etc.
	const clickPressActions =
		/(?:click|press|select|choose|tap(?:\s+on)?|hit)\s+(?:the\s+)?([a-z0-9\s]+)(?:\s+button|link)?/i;
	// Pattern 7: Narration - "Read the main content", "What's on my screen", etc.
	const narrateContent =
		/(read|speak|narrate|tell me about)(\s+the)?(\s+(main|this|page))?(\s+content)?|(what'?s|what is)(\s+on)?(\s+my|\s+this|\s+the)?(\s+screen|page|window|display)/i;

	// Extension actions - "mute microphone", "volume up", etc.
	// Pattern 7: microphone mute
	const microphoneMute = /(mute)?\s*(?:the|my\s+)?mic(rophone)?(mute)?/i;
	// Pattern 8: Volume mute, up, down
	const volumeShift = /(turn|change)?\s*volume\s+(up|down|mute)/i;
	// Pattern 9: Set volume to specific number
	const setVolume = /(set|change)?\s*volume\s*(to|set)?\s*(\d+)/i;
	// Pattern 10: Toggle transcript
	const toggleTranscript = /(show|hide|toggle)\s+transcript/i;

	let match;
	let destination;

	// Assign extension-related actions
	if ((match = microphoneMute.exec(transcript))) {
		destination = "micmute";
	} else if ((match = volumeShift.exec(transcript))) {
		destination =
			match[match.length - 1] === "mute"
				? "volume mute"
				: match[match.length - 1] === "up"
					? "volume up"
					: "volume down";
	} else if ((match = setVolume.exec(transcript))) {
		destination = `volume ${match[match.length - 1]}`;
	} else if ((match = toggleTranscript.exec(transcript))) {
		destination = "toggletranscript";
	}

	// Assigns an action to an according
	else if ((match = contextNavigation.exec(transcript))) {
		destination = match[1];
	} else if ((match = clickPressActions.exec(transcript))) {
		destination = match[1];
	} else if ((match = specificNeeds.exec(transcript))) {
		destination = match[1];
	} else if ((match = conversationalPhrases.exec(transcript))) {
		destination = match[1];
	} else if ((match = questionForms.exec(transcript))) {
		destination = match[1];
	} else if ((match = directCommands.exec(transcript))) {
		destination = match[1];
	} else if ((match = narrateContent.exec(transcript))) {
		return "narrate";
	}
	// If there was a RegEx match,
	// remove words like "please", "pls", "plz".
	if (destination) {
		destination = destination
			.replace(/please|pls|plz/gi, "")
			.trim()
			.toLowerCase();
	}
	return destination;
}

export { routeActions };
