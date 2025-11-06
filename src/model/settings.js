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
 * This centralizes the logic for fetching settings with defaults.
 * (Option A) NOTE: Not exported here — exported only once in the block at bottom.
 */
function getSettingWithDefault(key, defaultValue) {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.get(key, (result) => {
        if (chrome.runtime.lastError) {
          console.warn("settings fallback:", chrome.runtime.lastError);
          resolve(defaultValue);
          return;
        }
        if (result && Object.prototype.hasOwnProperty.call(result, key)) {
          resolve(result[key]);
        } else {
          try {
            chrome.storage.sync.set({ [key]: defaultValue }, () => resolve(defaultValue));
          } catch {
            resolve(defaultValue);
          }
        }
      });
    } catch (e) {
      console.warn("settings error:", e);
      resolve(defaultValue);
    }
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

  // Update the storage to keep popup UI in sync
  chrome.storage.sync.set({ microphoneActive: recognitionState.isRecognizing });
}

// Function to adjust volume
function adjustVolume(destination) {
  // Placeholder for any audio output volume handling
  let action;
  let currVol;
  let newVol;

  // Get the current volume from storage
  chrome.storage.sync.get("volume", (data) => {
    currVol = parseInt(data.volume);
    if (Number.isNaN(currVol)) {
      currVol = DEFAULT_SETTINGS.volume;
    }
  });

  setTimeout(function () {
    action = destination.split(" ")[1]; // up/down/mute
    if (action === "mute") {
      newVol = 0;
    } else if (action === "up") {
      newVol = Math.min(100, currVol + 10);
    } else if (action === "down") {
      newVol = Math.max(0, currVol - 10);
    }

    chrome.storage.sync.set({ volume: newVol });
    console.log(`Volume adjusted to: ${newVol}`);
  }, 100);
}

function setVolume(volume) {
  volume = Math.min(100, Math.max(0, Number(volume)));
  chrome.storage.sync.set({ volume });

  setTimeout(function () {
    console.log(`Volume set to: ${volume}`);
  }, 100);
}

function isHotkeyMatch(event, hotkey) {
  // Legacy string format
  if (typeof hotkey === "string") {
    return event.key.toLowerCase() === hotkey.toLowerCase();
  }

  // Object format with modifiers
  return (
    (!hotkey.ctrl || event.ctrlKey) &&
    (!hotkey.alt || event.altKey) &&
    (!hotkey.shift || event.shiftKey) &&
    event.key.toLowerCase() === (hotkey.key || "").toLowerCase()
  );
}

function extensionActionRouter(destination, recognitionState) {
  // quick volume set: "volume 75"
  if (destination.match(/volume\s[0-9]+/)) {
    const val = destination.replace(/volume\s/, "");
    setVolume(val);
    return true;
  }

  switch (destination) {
    case "micmute":
      toggleMicrophone(recognitionState);
      break;
    case "volume up":
    case "volume down":
    case "volume mute":
      adjustVolume(destination);
      break;
    case "toggletranscript":
      toggleTranscript();
      break;
    default:
      return false;
  }
  return true;
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
