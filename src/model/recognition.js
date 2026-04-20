import { routeActions } from "../controller/router.js";

// start speech recognition with appropriate audio device
function initRecognition(recognitionState, deviceId = null) {
	const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

	// If there's an existing recognition object and it's active, stop it
	if (recognitionState.recognition && recognitionState.isRecognizing) {
		recognitionState.recognition.stop();
		recognitionState.isRecognizing = false;
	}

	// Create a new recognition instance
	const newRecognition = new SpeechRecognition();
	newRecognition.continuous = true;
	newRecognition.interimResults = true;
	newRecognition.lang = "en-US";
	recognitionState.recognition = newRecognition;

	// If a specific device ID is provided and it's not the default
	if (deviceId && deviceId !== "default") {
		try {
			// Use the SpeechRecognition API's mediaDeviceId option if supported
			newRecognition.mediaDeviceId = deviceId;
		} catch (e) {
			console.warn("This browser doesn't support selecting audio input devices for SpeechRecognition:", e);
		}
	}

	// This event is fired when speech recognition starts
	newRecognition.onresult = (event) => {
		let transcript = "";
		for (let i = event.resultIndex; i < event.results.length; i++) {
			transcript += event.results[i][0].transcript;
		}
		recognitionState.speechDisplay.textContent = transcript;

		// We want to wait a bit before sending the transcript to actions to avoid flooding it with too many calls
		// This debounce mechanism ensures that we only call actions once the user has paused speaking
		clearTimeout(window.debounceTimer);
		window.debounceTimer = setTimeout(async () => {
			// IMPORTANT: This is where we call pass control to the actions.js script
			// to handle the speech commands. The actions function should be defined in actions.js.
			await routeActions(transcript, recognitionState);

			const m = transcript.match(/(?:open\s+)?(.+?)\s+assignments?$/i);
			if (m) {
				const courseName = m[1].trim();
				chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
					if (!tabs || !tabs[0]) return;
					chrome.tabs.sendMessage(tabs[0].id, { action: "navigateToCourseAssignments", courseName }, (resp) => {
						if (chrome.runtime.lastError) {
							// not on a matched page or content script not injected
							console.warn("sendMessage error:", chrome.runtime.lastError.message);
						} else if (resp && resp.success) {
							// optional: give user feedback via your tts helper
						} else {
							// handle course not found
						}
					});
				});
			}
		}, 1000);
	};

	// This event is fired when speech recognition detects no speech for a while and stops
	newRecognition.onend = () => {
		recognitionState.isRecognizing = false;
		// Update storage when recognition ends
		chrome.storage.sync.set({ microphoneActive: false });
	};

	newRecognition.onerror = (event) => {
		console.error("Speech recognition error:", event.error);
		recognitionState.isRecognizing = false;
		// Update storage when recognition errors
		chrome.storage.sync.set({ microphoneActive: false });
	};

	// Start recognition if it was previously active
	// This ensures that if the user had the microphone active before, it will restart automatically
	// We can decide to remove this if we want to avoid auto-starting recognition on page load
	// but for now, it provides a smoother user experience
	if (recognitionState.isRecognizing) {
		try {
			newRecognition.start();
		} catch (e) {
			console.error("Failed to restart speech recognition:", e);
		}
	}
}

export { initRecognition };
