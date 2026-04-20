import { textToSpeech } from "./tts.js";

function wasATextAction(transcript, recognitionState) {
	//R
	if (/^(open|click|start)\s+reply/i.test(transcript)) {
		const success = openDiscussionReply();
		if (success) {
			textToSpeech("Reply box opened", recognitionState);
		}
		return success;
	}

	// Handle "reply with X" - opens discussion reply and enters text
	const replyMatch = /(reply|respond)\s+(?:with|saying)\s+(.+)/i.exec(transcript);
	if (replyMatch) {
		// Ensure match exists and has the expected groups before trying to access
		const textToEnter = replyMatch[2].trim();

		// First open the reply box
		const replyOpened = openDiscussionReply();

		// Then try to enter the text (with a small delay to allow the editor to load)
		if (replyOpened) {
			textToSpeech("Reply box opened, adding your text", recognitionState);
			setTimeout(() => {
				// Use the existing function to write to the discussion box
				const textCommand = `write ${textToEnter}`;
				handleDiscussionBoxCommand(textCommand, recognitionState);
			}, 500);
			return true;
		} else {
			return false;
		}
	}

	if (handleDiscussionBoxCommand(transcript, recognitionState)) {
		return true;
	} // Check if it's a discussion box command

	// Check for submit commands anywhere in the transcript
	if (/submit|send|post/i.test(transcript)) {
		const success = submitDiscussionReply();
		if (success) {
			textToSpeech("Reply submitted successfully", recognitionState);
		}
		return success;
	}

	return false; // No text action matched
	//R
}

//R
function submitDiscussionReply() {
	// Find the reply button using the exact selector from your Canvas HTML
	const submitButton = document.querySelector('button[data-testid="DiscussionEdit-submit"]');

	if (submitButton) {
		submitButton.click();
		console.log("Successfully clicked the Reply button");
		return true;
	} else {
		console.warn("Reply button not found - are you on a discussion page?");
		return false;
	}
}

function openDiscussionReply() {
	// Find the reply button using the exact selector from your Canvas HTML
	const replyButton = document.querySelector('button[data-testid="discussion-topic-reply"]');

	if (replyButton) {
		replyButton.click();
		console.log("Successfully clicked the Reply button");
		return true;
	} else {
		return false;
	}
}

function handleDiscussionBoxCommand(transcript, recognitionState) {
	// 1. Extract text from commands
	const inputRegex =
		/(?:write|type|paste|input|can you)\s+(?:in\s+)?(?:the\s+)?(?:discussion\s+box|text\s+box|input\s+field)?\s*(.+)/i;
	const match = inputRegex.exec(transcript);

	if (!match) return false; // Not a discussion box command
	const textToPaste = match[1].trim();

	if (!textToPaste) return false;

	// 2. Find the Canvas editor iframe
	const iframe = document.querySelector("iframe.tox-edit-area__iframe, #message-body-root_ifr");
	if (!iframe) return false; //Not on discussion page

	try {
		// 3. Focus the editor
		iframe.focus();
		const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;

		// 4. Find or create the paragraph element
		let paragraph = iframeDoc.querySelector("p");

		// 5. Insert text and trigger all necessary events
		paragraph.textContent = textToPaste;

		// These events make Canvas detect the changes
		["input", "change", "keydown", "keyup", "blur"].forEach((eventType) => {
			paragraph.dispatchEvent(new Event(eventType, { bubbles: true }));
		});
		console.log("Success! Pasted:", textToPaste);
		textToSpeech("Text added to discussion box", recognitionState);
		return true;
	} catch (error) {
		console.warn("Failed to paste text:", error);
		return false;
	}
}
//R

export { wasATextAction };
