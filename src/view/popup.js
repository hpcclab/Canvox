"use strict";

document.addEventListener("DOMContentLoaded", () => {
	const toggleButton = document.querySelector(".theme-toggle");
	const transcriptButton = document.querySelector(".transcript");
	const hotkeyButton = document.querySelector(".change-hotkeys");
	const micToggle = document.getElementById("micToggle");
	const audioInput = document.getElementById("audioInput");
	const audioOutput = document.getElementById("audioOutput");
	const volumeSlider = document.getElementById("volumeAdjust");
	const feedbackSoundsToggle = document.getElementById("feedbackSoundsToggle"); // Add this line

	// Default settings (fallback in case defaults.js hasn't loaded)
	const DEFAULT_SETTINGS = window.DEFAULT_SETTINGS || {
		theme: "dark",
		hotkeyMicrophone: { ctrl: false, alt: false, shift: false, key: "x" },
		hotkeyTranscript: { ctrl: true, alt: false, shift: false, key: " " }, // Ctrl + Space
		hotkeyReadoutDown: { ctrl: false, alt: false, shift: false, key: "Down" },
		hotkeyReadoutUp: { ctrl: false, alt: false, shift: false, key: "Up" },
		microphoneActive: false,
		audioInput: "default",
		audioOutput: "default",
		volume: 100,
		feedbackSoundsEnabled: true, // Add this line
	};

	// Helper function to get settings with defaults
	function getSettingWithDefault(key, defaultValue) {
		if (window.getSettingWithDefault) {
			return window.getSettingWithDefault(key, defaultValue);
		}

		// Fallback in case defaults.js hasn't loaded
		return new Promise((resolve) => {
			chrome.storage.sync.get(key, (result) => {
				if (chrome.runtime.lastError) {
					console.error(chrome.runtime.lastError);
				}

				// If setting doesn't exist, save and use default
				if (result[key] === undefined) {
					chrome.storage.sync.set({ [key]: defaultValue });
					resolve(defaultValue);
				} else {
					resolve(result[key]);
				}
			});
		});
	}

	function themetoggle() {
		if (!toggleButton || !transcriptButton || !hotkeyButton) {
			console.error("One or more theme toggle elements are missing.");
			return;
		}

		document.body.classList.toggle("light-mode");
		toggleButton.classList.toggle("button-light-mode");
		transcriptButton.classList.toggle("button-light-mode");
		hotkeyButton.classList.toggle("button-light-mode");

		const currentTheme = document.body.classList.contains("light-mode") ? "light" : "dark";
		chrome.storage.sync.set({ theme: currentTheme }, () => {
			console.log("Theme saved:", currentTheme);
		});
	}

	if (toggleButton) {
		toggleButton.addEventListener("click", themetoggle);
	}

	// Load the theme from storage with default
	getSettingWithDefault("theme", DEFAULT_SETTINGS.theme).then((theme) => {
		if (theme === "light") {
			document.body.classList.add("light-mode");
			if (toggleButton) toggleButton.classList.add("button-light-mode");
			if (transcriptButton) transcriptButton.classList.add("button-light-mode");
			if (hotkeyButton) hotkeyButton.classList.add("button-light-mode");
		}
	});

	// Hotkey Settings Panel
	const changeHotkeysBtn = document.querySelector(".change-hotkeys");
	const settingsPanel = document.querySelector(".hotkey-settings");
	const closeSettingsBtn = document.getElementById("close-settings");

	if (changeHotkeysBtn && settingsPanel && closeSettingsBtn) {
		// Show settings panel
		changeHotkeysBtn.addEventListener("click", () => {
			settingsPanel.style.display = "block";
		});

		// Hide settings panel
		closeSettingsBtn.addEventListener("click", () => {
			settingsPanel.style.display = "none";
		});
	} else {
		console.error("One or more hotkey settings elements are missing.");
	}

	// Improved Hotkey Capture System
	function setupHotkeyCapture(inputId, saveButtonId, storageKey) {
		const inputField = document.getElementById(inputId);
		const saveButton = document.getElementById(saveButtonId);

		// Current key combination being captured
		let currentKeyCombo = {
			ctrl: false,
			alt: false,
			shift: false,
			key: "",
		};

		// Function to update the input field display
		function updateInputDisplay() {
			let display = [];
			if (currentKeyCombo.ctrl) display.push("Ctrl");
			if (currentKeyCombo.alt) display.push("Alt");
			if (currentKeyCombo.shift) display.push("Shift");

			// Handle special keys, particularly Space
			if (currentKeyCombo.key) {
				let keyDisplay = currentKeyCombo.key;
				if (currentKeyCombo.key === " ") {
					keyDisplay = "Space";
				} else if (!["Control", "Alt", "Shift"].includes(currentKeyCombo.key)) {
					// Keep the key as is for other keys
				}
				display.push(keyDisplay);
			}

			inputField.value = display.join(" + ");
		}

		// When input field is clicked, prepare for key capture
		inputField.addEventListener("click", (e) => {
			e.preventDefault();
			inputField.value = "Press key combination...";
			inputField.classList.add("capturing");

			// Reset current combination
			currentKeyCombo = { ctrl: false, alt: false, shift: false, key: "" };
		});

		// Capture keys
		inputField.addEventListener("keydown", (e) => {
			e.preventDefault();

			if (inputField.classList.contains("capturing")) {
				// Detect modifier keys
				if (e.key === "Control" || e.key === "Ctrl") {
					currentKeyCombo.ctrl = true;
				} else if (e.key === "Alt") {
					currentKeyCombo.alt = true;
				} else if (e.key === "Shift") {
					currentKeyCombo.shift = true;
				} else {
					// For regular keys
					currentKeyCombo.key = e.key;

					// Auto-update display when a regular key is pressed
					updateInputDisplay();
					inputField.classList.remove("capturing");
				}

				// If only modifier keys are pressed, update the display
				if (!currentKeyCombo.key) {
					updateInputDisplay();
				}
			}
		});

		// Handle key up to detect when modifiers are released
		inputField.addEventListener("keyup", (e) => {
			if (inputField.classList.contains("capturing")) {
				if (e.key === "Control" || e.key === "Ctrl") currentKeyCombo.ctrl = false;
				if (e.key === "Alt") currentKeyCombo.alt = false;
				if (e.key === "Shift") currentKeyCombo.shift = false;

				updateInputDisplay();
			}
		});

		// Handle save button
		saveButton.addEventListener("click", () => {
			// Don't save empty combinations
			if (!currentKeyCombo.key && !currentKeyCombo.ctrl && !currentKeyCombo.alt && !currentKeyCombo.shift) {
				alert("Please set a valid key combination");
				return;
			}

			// Save key combination
			chrome.storage.sync.set(
				{
					[storageKey]: {
						ctrl: currentKeyCombo.ctrl,
						alt: currentKeyCombo.alt,
						shift: currentKeyCombo.shift,
						key: currentKeyCombo.key,
					},
				},
				() => {
					console.log(`Hotkey for ${storageKey} set to:`, inputField.value);
					inputField.blur(); // Remove focus
				},
			);
		});

		// Prevent default form submission
		inputField.form?.addEventListener("submit", (e) => e.preventDefault());
	}

	// Set up hotkey capture for each hotkey input
	setupHotkeyCapture("hotkey-microphone", "save-microphone", "hotkeyMicrophone");
	setupHotkeyCapture("hotkey-transcript", "save-transcript", "hotkeyTranscript");
	setupHotkeyCapture("hotkey-readoutdown", "save-readoutdown", "hotkeyReadoutDown");
	setupHotkeyCapture("hotkey-readoutup", "save-readoutup", "hotkeyReadoutUp");

	// Load Stored Hotkeys with defaults
	Promise.all([
		getSettingWithDefault("hotkeyMicrophone", DEFAULT_SETTINGS.hotkeyMicrophone),
		getSettingWithDefault("hotkeyTranscript", DEFAULT_SETTINGS.hotkeyTranscript),
		getSettingWithDefault("hotkeyReadoutDown", DEFAULT_SETTINGS.hotkeyReadoutDown),
		getSettingWithDefault("hotkeyReadoutUp", DEFAULT_SETTINGS.hotkeyReadoutUp),
	]).then(([micHotkey, transcriptHotkey, readoutDownHotkey, readoutUpHotkey]) => {
		// Format the display of each hotkey
		function formatHotkeyDisplay(hotkey) {
			if (typeof hotkey === "string") {
				// Legacy format - just a key string
				return hotkey === " " ? "Space" : hotkey;
			} else {
				// New format - key combination object
				let display = [];
				if (hotkey.ctrl) display.push("Ctrl");
				if (hotkey.alt) display.push("Alt");
				if (hotkey.shift) display.push("Shift");

				// Handle Space key specially
				if (hotkey.key) {
					if (hotkey.key === " ") {
						display.push("Space");
					} else {
						display.push(hotkey.key);
					}
				}
				return display.join(" + ");
			}
		}

		document.getElementById("hotkey-microphone").value = formatHotkeyDisplay(micHotkey);
		document.getElementById("hotkey-transcript").value = formatHotkeyDisplay(transcriptHotkey);
		document.getElementById("hotkey-readoutdown").value = formatHotkeyDisplay(readoutDownHotkey);
		document.getElementById("hotkey-readoutup").value = formatHotkeyDisplay(readoutUpHotkey);

		// No need for special transcript label anymore as all hotkeys can have combinations
	});

	// Transcript Button - Now sending message to toggle visibility
	transcriptButton.addEventListener("click", () => {
		chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
			if (tabs[0]) {
				chrome.tabs.sendMessage(tabs[0].id, {
					action: "toggleTranscript",
				});
			}
		});
	});

	// Microphone Toggle
	micToggle.addEventListener("change", () => {
		const isMicActive = micToggle.checked;
		chrome.storage.sync.set({ microphoneActive: isMicActive }, () => {
			console.log("Microphone Status:", isMicActive);
		});
	});

	// Load Microphone State with default
	getSettingWithDefault("microphoneActive", DEFAULT_SETTINGS.microphoneActive).then((isActive) => {
		micToggle.checked = isActive;
	});

	// Audio Input Selection
	navigator.mediaDevices
		.enumerateDevices()
		.then((devices) => {
			// Clear existing options except the default one
			while (audioInput.options.length > 1) {
				audioInput.options.remove(1);
			}

			// Set the first option as "system default"
			audioInput.options[0].textContent = "System Default";
			audioInput.options[0].value = "default";

			// Add the actual input devices
			const inputDevices = devices.filter((device) => device.kind === "audioinput");
			inputDevices.forEach((device, index) => {
				let option = document.createElement("option");
				option.value = device.deviceId;
				option.textContent = device.label || `Microphone ${index + 1}`;
				audioInput.appendChild(option);
			});
		})
		.catch((err) => {
			console.error("Error enumerating audio devices:", err);
		});

	// Audio Output Selection
	navigator.mediaDevices
		.enumerateDevices()
		.then((devices) => {
			// Clear existing options except the default one
			while (audioOutput.options.length > 1) {
				audioOutput.options.remove(1);
			}

			// Set the first option as "system default"
			audioOutput.options[0].textContent = "System Default";
			audioOutput.options[0].value = "default";

			// Add the actual output devices
			const outputDevices = devices.filter((device) => device.kind === "audiooutput");
			outputDevices.forEach((device, index) => {
				let option = document.createElement("option");
				option.value = device.deviceId;
				option.textContent = device.label || `Speaker ${index + 1}`;
				audioOutput.appendChild(option);
			});
		})
		.catch((err) => {
			console.error("Error enumerating audio devices:", err);
		});

	// Save Audio Input/Output Selection
	audioInput.addEventListener("change", () => {
		chrome.storage.sync.set({ audioInput: audioInput.value }, () => {
			// Send message to content script to update the microphone
			chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
				if (tabs[0]) {
					chrome.tabs.sendMessage(tabs[0].id, {
						action: "updateAudioInput",
						deviceId: audioInput.value,
					});
				}
			});
		});
	});

	audioOutput.addEventListener("change", () => {
		chrome.storage.sync.set({ audioOutput: audioOutput.value });
	});

	// Load Saved Audio Preferences with defaults
	Promise.all([
		getSettingWithDefault("audioInput", DEFAULT_SETTINGS.audioInput),
		getSettingWithDefault("audioOutput", DEFAULT_SETTINGS.audioOutput),
	]).then(([inputDevice, outputDevice]) => {
		// Set audio input device if it exists in the list
		if (inputDevice) {
			// Check if the device exists in the list
			let deviceExists = false;
			for (let i = 0; i < audioInput.options.length; i++) {
				if (audioInput.options[i].value === inputDevice) {
					audioInput.value = inputDevice;
					deviceExists = true;
					break;
				}
			}

			// If device doesn't exist, set to default
			if (!deviceExists) {
				audioInput.value = "default";
				chrome.storage.sync.set({ audioInput: "default" });
			}
		}

		// Same check for output device
		if (outputDevice) {
			let deviceExists = false;
			for (let i = 0; i < audioOutput.options.length; i++) {
				if (audioOutput.options[i].value === outputDevice) {
					audioOutput.value = outputDevice;
					deviceExists = true;
					break;
				}
			}

			if (!deviceExists) {
				audioOutput.value = "default";
				chrome.storage.sync.set({ audioOutput: "default" });
			}
		}
	});

	// Volume Slider
	volumeSlider.addEventListener("input", () => {
		chrome.storage.sync.set({ volume: volumeSlider.value }, () => {
			console.log("Volume Set:", volumeSlider.value);
		});
	});

	// Load Volume Settings with default
	getSettingWithDefault("volume", DEFAULT_SETTINGS.volume).then((vol) => {
		volumeSlider.value = vol;
	});

	// Add event listener for feedback sounds toggle
	if (feedbackSoundsToggle) {
		feedbackSoundsToggle.addEventListener("change", () => {
			chrome.storage.sync.set({ feedbackSoundsEnabled: feedbackSoundsToggle.checked }, () => {
				console.log("Feedback sounds " + (feedbackSoundsToggle.checked ? "enabled" : "disabled"));
			});
		});

		// Load the feedback sounds setting from storage
		getSettingWithDefault("feedbackSoundsEnabled", DEFAULT_SETTINGS.feedbackSoundsEnabled).then((enabled) => {
			feedbackSoundsToggle.checked = enabled;
		});
	}
});

function isCanvasUrl(url) {
  return /https?:\/\/([^.]+\.)?instructure\.com/.test(url) || /https?:\/\/your\.canvas\.domain/.test(url);
}

function sendToActiveTab(message, onResponse) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab) {
      console.warn("No active tab");
      return;
    }

    if (!isCanvasUrl(tab.url || "")) {
      // Save intent to storage so pages/bkg can react later
      console.warn("Active tab is not a Canvas page. Persisting state to storage instead.");
      if (message && message.action === "toggleMicrophone") {
        chrome.storage.sync.set({ microphoneActive: !!message.active }, () => {
          if (chrome.runtime.lastError) console.error("storage.set error:", chrome.runtime.lastError.message);
          if (onResponse) onResponse({ saved: true });
        });
      }
      return;
    }

    chrome.tabs.sendMessage(tab.id, message, (resp) => {
      if (chrome.runtime.lastError) {
        console.warn("sendMessage failed:", chrome.runtime.lastError.message);
        // fallback: persist change to storage so main.js can pick it up next navigation
        if (message && message.action === "toggleMicrophone") {
          chrome.storage.sync.set({ microphoneActive: !!message.active }, () => {
            if (chrome.runtime.lastError) console.error("storage.set error:", chrome.runtime.lastError.message);
            if (onResponse) onResponse({ savedFallback: true });
          });
        }
        return;
      }
      if (onResponse) onResponse(resp);
    });
  });
}

// Example: toggle button handler
document.getElementById("toggleBtn")?.addEventListener("click", async () => {
  // determine new state (example: read current from storage)
  chrome.storage.sync.get("microphoneActive", (res) => {
    const newState = !res.microphoneActive;
    // try to message the page; if no page listener, we'll save to storage in the wrapper
    sendToActiveTab({ action: "toggleMicrophone", active: newState }, (resp) => {
      // update popup UI
      const status = document.getElementById("status");
      if (status) status.textContent = resp && (resp.saved || resp.savedFallback) ? "Saved state" : newState ? "Microphone on" : "Microphone off";
    });
  });
});
