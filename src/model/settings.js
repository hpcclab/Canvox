import { initRecognition } from "./recognition.js";
import { toggleTranscript } from "../controller/injectElements.js";

/**
 * Default settings for Canvox extension
 * This file centralizes all default values used across the application
 */
const DEFAULT_SETTINGS = {
	// Theme
	theme: "dark",

	// Hotkeys - now using objects for key combinations
	hotkeyMicrophone: { ctrl: false, alt: false, shift: false, key: "x" },
	hotkeyTranscript: { ctrl: true, alt: false, shift: false, key: " " }, // Ctrl + Space
	hotkeyReadoutDown: { ctrl: false, alt: false, shift: false, key: "Down" },
	hotkeyReadoutUp: { ctrl: false, alt: false, shift: false, key: "Up" },

	// Microphone state
	microphoneActive: false,
	preserveMic: true,

	// Transcript visibility
	transcriptVisible: true,

	// Audio preferences
	audioInput: "default",
	audioOutput: "default",

	// Volume
	volume: 100, // Scale 0-100
};

/**
 * Helper function to get setting with default
 * This centralizes the logic for fetching settings with defaults
 */
function getSettingWithDefault(key, defaultValue) {
	return new Promise((resolve) => {
		chrome.storage.sync.get(key, (result) => {
			if (chrome.runtime.lastError) {
				console.warn(chrome.runtime.lastError);
			}

			// If setting doesn't exist, save and use default
			if (result[key] === undefined) {
				chrome.storage.sync.set({ [key]: defaultValue || DEFAULT_SETTINGS[key] });
				resolve(defaultValue || DEFAULT_SETTINGS[key]);
			} else {
				resolve(result[key]);
			}
		});
	});
}

// Function to toggle microphone state
async function toggleMicrophone(recognitionState) {
	if (recognitionState.isRecognizing) {
		recognitionState.recognition.stop();
		recognitionState.isRecognizing = false;
	} else {
		if (!recognitionState.recognition) {
			const deviceId = await getSettingWithDefault("audioInput", DEFAULT_SETTINGS.audioInput);
			initRecognition(recognitionState, deviceId);
			recognitionState.recognition.start();
			recognitionState.isRecognizing = true;
		} else {
			recognitionState.recognition.start();
			recognitionState.isRecognizing = true;
		}
	}

	// Update the storage to keep popup UI in sync. So that when the user presses hotkey, the popup reflects the correct state
	// of the microphone (active/inactive).
	chrome.storage.sync.set({ microphoneActive: recognitionState.isRecognizing });
}

// Function to adjust volume
function adjustVolume(destination) {
	// This function can be used to adjust the volume of the speech synthesis or any other audio output
	// For now, it's a placeholder as SpeechRecognition doesn't have a direct volume control
	// You can implement this based on your requirements

	let action;
	let currVol;
	let newVol;

	// Get the current volume from storage
	chrome.storage.sync.get("volume", (data) => {
		currVol = parseInt(data.volume); // Retrieve current volume
		if (currVol === undefined) {
			// If volume is not set, default to 50
			currVol = DEFAULT_SETTINGS.volume;
		}
	});

	setTimeout(function () {
		action = destination.split(" ")[1]; // Extract the volume change from the destination string
		if (action == "mute") {
			newVol = 0;
		} else if (action == "up") {
			newVol = Math.min(100, currVol + 10); // Increase volume by 10, max 100
		} else if (action == "down") {
			newVol = Math.max(0, currVol - 10); // Decrease volume by 10, min 0
		}

		chrome.storage.sync.set({ volume: newVol });
		console.log(`Volume adjusted to: ${newVol}`); // Log the new volume for debugging
	}, 100); // Change newVol and store after a short delay to ensure currVol is set correctly
}

function setVolume(volume) {
	// This function can be used to set the volume of the speech synthesis or any other audio output
	// Ensure volume is between 0 and 100
	volume = Math.min(100, volume);
	volume = Math.max(0, volume);

	// Set the volume in the storage
	chrome.storage.sync.set({ volume: volume });

	setTimeout(function () {
		console.log(`Volume set to: ${volume}`); // Log the new volume
	}, 100);
}

function isHotkeyMatch(event, hotkey) {
	// Handle legacy format (string)
	if (typeof hotkey === "string") {
		return event.key.toLowerCase() === hotkey.toLowerCase();
	}

	// New format (object with modifiers)
	// Ensure the hotkey object has a key property to prevent errors
	return (
		(!hotkey.ctrl || event.ctrlKey) &&
		(!hotkey.alt || event.altKey) &&
		(!hotkey.shift || event.shiftKey) &&
		event.key.toLowerCase() === (hotkey.key || "").toLowerCase()
	);
}

function extensionActionRouter(destination, recognitionState) {
	// This function routes to extension-specific actions
	// based on the destination provided

	// First check if destination is a volume set command
	// since the case block would need 100 cases for each possible regex here
	if (destination.match(/volume\s[0-9]+/)) {
		destination = destination.replace(/volume\s/, "");
		setVolume(destination);
		return true;
	}

	// Handle other extension actions
	switch (destination) {
		case "micmute":
			// Handle microphone mute action
			toggleMicrophone(recognitionState); // Call the function to toggle the microphone state
			break;
		case "volume up":
		case "volume down":
		case "volume mute":
			// Handle volume adjustment actions
			adjustVolume(destination);
			break;
		case "toggletranscript":
			// Handle toggle transcript action
			toggleTranscript(); // Call the function to toggle the transcript visibility
			break;
		default:
			return false; // No matching action found
	}
	return true; // Successfully handled an extension action
}

export const POSSIBLE_EXTENSION_ACTIONS = [
	"micmute",
	"volume up",
	"volume down",
	"volume mute",
	"volume [0-9]{1,3}",
	"toggletranscript",
	"explain options",
];

export {
	getSettingWithDefault,
	DEFAULT_SETTINGS,
	toggleMicrophone,
	adjustVolume,
	setVolume,
	isHotkeyMatch,
	extensionActionRouter,
};
