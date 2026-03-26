import { textToSpeech } from "../model/tts.js";

// Global variables to store message elements
let allMessages = null;
let unreadMessage = null;
let starredMessage = null;
let lastMessage = null;

// Arrays to store message data
let messageObjects = [];

// Assigns message elements to their respective variables and extracts message data
function assignMessages() {
	// Get all messages with class css-138gh4t-view
	allMessages = document.querySelectorAll('[data-testid="conversationListItem-Item"]');

	// Get all unread messages by finding elements with data-testid="unread-badge"
	unreadMessage = document.querySelectorAll('[data-testid="unread-badge"]');

	// Get starred messages
	starredMessage = document.querySelectorAll('[data-testid="visible-starred"]');

	// Assign data for each message object
	messageObjects = Array.from(allMessages).map((message) => {
		// Extract date
		const dateElement = message.querySelector(".css-1bw2jwe-text");
		const date = dateElement ? dateElement.textContent : "";

		// Extract names
		const nameElement = message.querySelector(".css-c31sii-text");
		const names = nameElement ? nameElement.textContent : "";

		// Extract header
		const headerElement = message.querySelector(".css-cv5a3j-view-heading");
		const header = headerElement ? headerElement.textContent : "";

		// Check if message is unread
		const isUnread = !!message.querySelector('[data-testid="unread-badge"]');

		// Check if message is starred
		const isStarred = !!message.querySelector('[data-testid="visible-starred"]');

		// Return the structured message object
		return {
			element: message,
			date: date,
			names: names,
			header: header,
			isUnread: isUnread,
			isStarred: isStarred,
		};
	});

	// console.log("Total messages:", allMessages.length);
	// console.log("Unread messages:", unreadMessage.length);
	// console.log("Starred messages:", starredMessage.length);
	// console.log("Message objects:", messageObjects);

	// Log detailed information about the first message if available
	if (messageObjects.length > 0) {
		lastMessage = messageObjects[0];
		// console.log("First message details:", {
		// 	date: firstMessage.date,
		// 	names: firstMessage.names,
		// 	header: firstMessage.header,
		// 	isUnread: firstMessage.isUnread,
		// 	isStarred: firstMessage.isStarred,
		// });
	} else {
		console.log("No messages found to display details");
	}

	console.log("Message objects:", messageObjects);
}

function wasAnInboxAction(transcript, recognitionState) {
	if (!window.location.href.includes("conversations")) return false;

	const lastMessagePattern =
		/\b(show|see|view|get|check|read|display|open|access)\b.+\b(last|latest|recent|newest)\b.+\b(message|msg|email|mail|conversation|inbox item)\b$/i;

	if (lastMessagePattern.test(transcript)) {
		clickLastMessage(recognitionState);
		return true;
	}

	return false;
}

function clickLastMessage(recognitionState) {
	if (!lastMessage) {
		console.warn("No last message found to click.");
		return;
	}

	// console.log(`Clicking last message: ${lastMessage.header}`);
	lastMessage.element.click();
	setTimeout(() => readMessageContent(recognitionState), 2000); // Wait for the message content to load
}

function clickMessage(input, recognitionState) {
	if (!allMessages || allMessages.length === 0) {
		console.warn("No messages found to click.");
		return;
	}

	// Extract the title Y from format "message X: Y names: ..."
	let title = input;
	const match = title.match(/message\s+\d+:\s+(.*?)\s+names:/i);
	if (match && match[1]) {
		title = match[1].trim();
	}

	// Find the message that matches the extracted title
	let found = false;
	messageObjects.forEach((message) => {
		if (message.header.toLowerCase().includes(title.toLowerCase())) {
			message.element.click();
			found = true;
			setTimeout(() => readMessageContent(recognitionState), 1000); // Wait for the message content to load
			return;
		}
	});

	if (!found) {
		console.warn(`No message found with title: ${title}`);
	}
}

function readMessageContent(recognitionState, attempt = 1) {
	const maxAttempts = 3;

	const messageContainer = document.querySelector(".css-103zv00-view-flexItem");

	const messageTitleElement = messageContainer?.querySelector('[data-testid="message-detail-header-desktop"]');
	const messageTitle = messageTitleElement?.textContent || null;

	// After all attempts or if title is found, continue with the function
	const finalMessageTitle = messageTitle || "No title found";

	const messageAuthor = messageContainer?.querySelector("span.css-g5lcut-text")?.textContent || "No author";

	const bodyElement = messageContainer?.querySelector("span.css-hszq8y-text");
	console.log(bodyElement);

	// If no body and we haven't reached max attempts, retry after delay
	if ((!bodyElement || messageAuthor == "No author") && attempt < maxAttempts) {
		console.log(`Attempt ${attempt}/${maxAttempts}: Message content not fully loaded, retrying in 2 seconds...`);
		return setTimeout(() => readMessageContent(recognitionState, attempt + 1), 2000);
	}

	// Extract message body content, handling line breaks and anchors
	let messageBody = "";
	if (bodyElement) {
		// Process all child nodes to handle text and anchors
		const processNode = (node) => {
			if (node.nodeType === Node.TEXT_NODE) {
				messageBody += node.textContent;
			} else if (node.nodeType === Node.ELEMENT_NODE) {
				if (node.tagName === "A") {
					// Include the href for anchor elements
					messageBody += `${node.textContent} (${node.href}) `;
				} else if (node.tagName === "BR") {
					messageBody += "\n";
				} else {
					// Recursively process other elements
					Array.from(node.childNodes).forEach(processNode);
				}
			}
		};

		Array.from(bodyElement.childNodes).forEach(processNode);
		messageBody = messageBody.trim();
	} else {
		messageBody = "No message content found";
	}

	const formattedMessage = `Message from ${messageAuthor}. Subject: ${finalMessageTitle}. Message body: ${messageBody}`;

	textToSpeech(formattedMessage, recognitionState);
}

export { assignMessages, clickMessage, messageObjects, wasAnInboxAction };
