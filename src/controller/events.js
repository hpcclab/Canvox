import { runAnnouncements } from "../model/newContent.js";
import { initRecognition } from "../model/recognition.js";
import { DEFAULT_SETTINGS, getSettingWithDefault, isHotkeyMatch, toggleMicrophone } from "../model/settings.js";
import { giveNavigationFeedback } from "../model/tts.js";
import { assignMessages } from "./inbox.js";
import { stopAudio, toggleTranscript } from "./injectElements.js";
import { routeActions } from "./router.js";

// Add a function to play audio feedback
async function playAudioFeedback(audioFile) {
	try {
		// Check if feedback sounds are enabled
		const data = await chrome.storage.sync.get("feedbackSoundsEnabled");
		const feedbackSoundsEnabled = data.feedbackSoundsEnabled !== undefined ? data.feedbackSoundsEnabled : true;

		// Only play if sounds are enabled
		if (feedbackSoundsEnabled) {
			const audio = new Audio(chrome.runtime.getURL(`audios/${audioFile}`));
			audio.play().catch((error) => console.error(`Error playing ${audioFile}:`, error));
			return audio;
		}
		return null;
	} catch (error) {
		console.warn(`Error checking feedback sounds setting:`, error);
		// Fallback to default behavior if there's an error
		const audio = new Audio(chrome.runtime.getURL(`audios/${audioFile}`));
		audio.play().catch((error) => console.error(`Error playing ${audioFile}:`, error));
		return audio;
	}
}

function setupListeners(recognitionState) {
	runAnnouncements(recognitionState);

	// Navigation event listener
	window.addEventListener("popstate", () => giveNavigationFeedback(recognitionState));

	// Inbox message assignment when DOM is loaded
	checkAndAssignMessages();

	// Listen for URL changes to detect when user navigates to inbox
	window.addEventListener("popstate", checkAndAssignMessages);

	// Also check on hash change (for single-page applications)
	window.addEventListener("hashchange", checkAndAssignMessages);

	//Hotkeys event listener
	document.addEventListener("keydown", async (e) => {
		// Microphone hotkey
		const hotkey = await getSettingWithDefault("hotkeyMicrophone", DEFAULT_SETTINGS.hotkeyMicrophone);
		if (isHotkeyMatch(e, hotkey)) {
			// Check if we're turning the mic on or off
			if (!recognitionState.isRecognizing) {
				stopAudio();
				// Play mic_on.mp3 when activating microphone
				playAudioFeedback("mic_on.mp3");
			} else {
				// Play mic_off.mp3 when deactivating microphone
				playAudioFeedback("mic_off.mp3");
			}
			toggleMicrophone(recognitionState);
			e.preventDefault(); // Prevent browser's default handling of this key
		}

		// Transcript hotkey
		getSettingWithDefault("hotkeyTranscript", DEFAULT_SETTINGS.hotkeyTranscript).then((hotkey) => {
			if (isHotkeyMatch(e, hotkey)) {
				toggleTranscript();
				e.preventDefault(); // Prevent browser's default handling of this key
			}
		});
	});

	// Listen for the TTS events
	document.addEventListener("tts-ready", async (event) => {
		const audioElement = event.detail.audioElement;

		// Add event listeners for tracking playback
		audioElement.addEventListener("play", () => {
			console.log("TTS audio playback started");
		});

		audioElement.addEventListener("ended", () => {
			console.log("TTS audio playback completed");
			// Remove the audio element after playback
			document.body.removeChild(audioElement);
		});

		audioElement.addEventListener("error", (e) => {
			console.error("Audio playback error:", e);
			document.body.removeChild(audioElement);
		});

		// Start playing the audio
		try {
			await audioElement.play();
			console.log("Playing TTS audio");
		} catch (error) {
			console.error("Error playing TTS audio:", error);
		}
	});

	// Listen for changes to the microphone state from the popup
	chrome.storage.onChanged.addListener(async (changes) => {
		if (changes.microphoneActive && changes.microphoneActive.newValue !== recognitionState.isRecognizing) {
			if (changes.microphoneActive.newValue === true && !recognitionState.isRecognizing) {
				// Stop audio playback when turning microphone on
				stopAudio();
				// Play mic_on.mp3 when activating microphone
				playAudioFeedback("mic_on.mp3");

				if (!recognitionState.recognition) {
					const deviceId = await getSettingWithDefault("audioInput", DEFAULT_SETTINGS.audioInput);
					initRecognition(recognitionState, deviceId);
					recognitionState.recognition.start();
					recognitionState.isRecognizing = true;
				} else {
					recognitionState.recognition.start();
					recognitionState.isRecognizing = true;
				}
			} else if (changes.microphoneActive.newValue === false && recognitionState.isRecognizing) {
				// Play mic_off.mp3 when deactivating microphone
				playAudioFeedback("mic_off.mp3");
				recognitionState.recognition.stop();
				recognitionState.isRecognizing = false;
			}
		}

		// Listen for audio input device changes
		if (changes.audioInput) {
			initRecognition(recognitionState, changes.audioInput.newValue);
		}
	});

	// Listen for messages from popup
	chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
		if (message.action === "updateAudioInput") {
			initRecognition(recognitionState, message.deviceId);
			sendResponse({ success: true });
			return true;
		}

		if (message.action === "toggleTranscript") {
			const newVisibility = toggleTranscript();
			sendResponse({ success: true, isVisible: newVisibility });
			return true;
		}
	});

	// This is for users who may not want to use the microphone or have accessibility needs
	document.querySelector(".voice-input").addEventListener("keydown", async (e) => {
		if (e.key === "Enter") {
			await routeActions(e.target.value);
			e.target.value = ""; // Clear the input after processing
		}
	});
}

// Call assignMessages if the page is messages
function checkAndAssignMessages() {
	const currentUrl = window.location.href;

	// Check if URL matches Canvas conversations pattern
	if (currentUrl.includes("conversations#filter=type=")) {
		console.log("Canvas conversation page detected, assigning messages...");

		// Sometimes the DOM might not be fully loaded with messages yet, so add a slight delay
		setTimeout(() => {
			assignMessages();

			// Get the current filter type from the URL (inbox, unread, starred, archived, etc.)
			const filterMatch = currentUrl.match(/filter=type=([^&]*)/);
			const filterType = filterMatch ? filterMatch[1] : "inbox";
			console.log(`Current filter: ${filterType}`);
		}, 2000);
	}
}

export { setupListeners, playAudioFeedback };
