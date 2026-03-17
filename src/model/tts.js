import { playAudio } from "../controller/injectElements.js";
import { playAudioFeedback } from "../controller/events.js"; // Import the function

// Replace your playLoadingAudio function with this
async function playLoadingAudio() {
	return await playAudioFeedback("loading.mp3");
}

// Check for navigation confirmation messages
async function giveNavigationFeedback(recognitionState) {
	try {
		const navigationData = sessionStorage.getItem("canvoxNavigation");
		if (navigationData) {
			const { message, timestamp } = JSON.parse(navigationData);

			// Only process messages that are less than 5 seconds old
			if (Date.now() - timestamp < 5000) {
				// Small delay to ensure the page has loaded
				setTimeout(async () => {
					// Get the volume setting
					const data = await chrome.storage.sync.get("volume");
					const volume = parseInt(data.volume) / 100;

					// Start playing loading audio
					const loadingAudio = await playLoadingAudio();

					try {
						const response = await fetch("https://glacial-sea-18791-40c840bc91e9.herokuapp.com/api/navigate", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({
								narrate_Content: message,
								is_navigation: true,
							}),
						});

						if (!response.ok) {
							throw new Error(`Server responded with ${response.status}: ${response.statusText}`);
						}

						// Create a URL for the audio blob
						const audioBlob = await response.blob();
						const audioUrl = URL.createObjectURL(audioBlob);

						// Stop loading audio
						loadingAudio.pause();
						loadingAudio.currentTime = 0;

						// Use the shared audio element to play
						const audioElement = await playAudio(audioUrl, volume, recognitionState);

						// Dispatch a custom event specifically for navigation feedback
						const navEvent = new CustomEvent("navigation-feedback", {
							detail: { audioElement, message },
						});
						document.dispatchEvent(navEvent);
					} catch (error) {
						console.warn("Error processing navigation message:", error);
						// Stop loading audio on error too
						loadingAudio.pause();
						loadingAudio.currentTime = 0;
					}
				}, 500);
			}

			// Clear the message after processing
			sessionStorage.removeItem("canvoxNavigation");
		}
	} catch (error) {
		console.warn("Error processing navigation message:", error);
	}
}

// Add this new function below collectMainContent
async function narratePage(transcript = "", recognitionState) {
	try {
		console.log("Preparing page narration with content summary...");

		// Get the page content
		let pageContent = collectMainContent();

		// Get the page title
		const pageTitle = document.title || "Current page";

		// Clean up the content - remove excessive whitespace
		pageContent = pageContent.replace(/\s+/g, " ").trim();

		// Create a summary prompt
		const narrateText = `Page title: ${pageTitle}. Content: ${pageContent}`;

		// Get the volume setting
		const data = await chrome.storage.sync.get("volume");
		const volume = parseInt(data.volume) / 100;

		// Start playing loading audio
		const loadingAudio = await playLoadingAudio();

		// Make a direct call to the narration API endpoint
		const response = await fetch(
			"https://glacial-sea-18791-40c840bc91e9.herokuapp.com/api/narrate",
			// Uncomment the line below, and comment the line above to test locally
			// 'http://localhost:3000/api/narrate',
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					page_content: narrateText,
					user_transcript: transcript,
					summarize: true,
				}),
			},
		);

		if (!response.ok) {
			throw new Error(`Server responded with ${response.status}: ${response.statusText}`);
		}

		// Create a URL for the audio blob
		const audioBlob = await response.blob();
		const audioUrl = URL.createObjectURL(audioBlob);

		// Stop loading audio
		loadingAudio.pause();
		loadingAudio.currentTime = 0;

		// Use the shared audio element to play
		const audioElement = await playAudio(audioUrl, volume, recognitionState);

		// Dispatch a custom event that content.js will listen for
		const narrateEvent = new CustomEvent("narrate-ready", { detail: { audioElement } });
		document.dispatchEvent(narrateEvent);

		return true;
	} catch (error) {
		console.warn("Error in narratePage function:", error);

		// Make sure loading audio stops if there was an error
		if (window.currentLoadingAudio) {
			window.currentLoadingAudio.pause();
			window.currentLoadingAudio.currentTime = 0;
		}

		return false;
	}
}

function collectMainContent() {
	// Collect the main content of the page for narration
	const mainContent = document.querySelector(".ic-Layout-contentMain");
	if (mainContent) {
		return mainContent.textContent || "";
	}
	return "";
}

async function textToSpeech(narrateContent, recognitionState) {
	try {
		console.log("Calling API (TTS)...");

		// Get the volume setting
		const data = await chrome.storage.sync.get("volume");
		const volume = parseInt(data.volume) / 100;

		// Start playing loading audio
		const loadingAudio = await playLoadingAudio();

		const response = await fetch(
			"https://glacial-sea-18791-40c840bc91e9.herokuapp.com/api/tts",
			// Uncomment the line below, and comment the line above to test locally
			// 'http://localhost:3000/api/tts',
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ narrate_Content: narrateContent }),
			},
		);

		if (!response.ok) {
			throw new Error(`Server responded with ${response.status}: ${response.statusText}`);
		}

		// Create a URL for the audio blob
		const audioBlob = await response.blob();
		const audioUrl = URL.createObjectURL(audioBlob);

		// Stop loading audio
		loadingAudio.pause();
		loadingAudio.currentTime = 0;

		// Use the shared audio element to play
		const audioElement = await playAudio(audioUrl, volume, recognitionState);

		// Dispatch a custom event that content.js will listen for
		const ttsEvent = new CustomEvent("tts-ready", { detail: { audioElement } });
		document.dispatchEvent(ttsEvent);
	} catch (error) {
		console.error("Error in textToSpeech function:", error);

		// Make sure loading audio stops if there was an error
		if (window.currentLoadingAudio) {
			window.currentLoadingAudio.pause();
			window.currentLoadingAudio.currentTime = 0;
		}
	}
}

export { giveNavigationFeedback, narratePage, textToSpeech };
