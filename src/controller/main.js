"use strict";

import { injectElements, toggleTranscript } from "./injectElements.js";
import { setupListeners } from "./events.js";
import { giveNavigationFeedback } from "../model/tts.js";
import { initRecognition } from "../model/recognition.js";
import { DEFAULT_SETTINGS, getSettingWithDefault } from "../model/settings.js";

//Entry point for the extension
export async function main() {
	//Initialize Transcript bar
	const { speechDisplay } = injectElements();

	// Check if the browser supports the SpeechRecognition API
	const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
	if (!SpeechRecognition) {
		speechDisplay.innerHTML = "Speech Recognition not supported in this browser.";
		return;
	}

	//Global state for speech recogniton
	const recognitionState = {
		recognition: null,
		isRecognizing: false,
		speechDisplay,
	};

	setupListeners(recognitionState);
	giveNavigationFeedback(recognitionState);

	// Persist microphone settings accross page navigation
	const [isActive, deviceId] = await Promise.all([
		getSettingWithDefault("microphoneActive", DEFAULT_SETTINGS.microphoneActive),
		getSettingWithDefault("audioInput", DEFAULT_SETTINGS.audioInput),
	]);
	initRecognition(recognitionState, deviceId);

	// Start recognition if it was previously active
	if (isActive && !recognitionState.isRecognizing) {
		recognitionState.recognition.start();
		recognitionState.isRecognizing = true;
	}
}
