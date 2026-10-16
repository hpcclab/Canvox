# Canvox

Canvox is a Chrome extension designed to make Canvas more accessible for blind and visually impaired users, while also supporting anyone who wants a hands-free Canvas experience. The system extends basic screen-reader functionality with voice-command navigation, spoken feedback, login assistance, and multi-step task support.

## Overview

Canvas is a learning management system used by many institutions to host courses and academic content. By default, it is primarily designed for mouse-and-keyboard interaction, which can create accessibility barriers for blind and visually impaired users.

Canvox addresses this challenge by combining screen-reader support with a voice-driven interaction pipeline that allows users to navigate and interact with Canvas through speech input and audio output.

## Problem

For blind and visually impaired students, standard navigation in Canvas can be difficult and inefficient. Basic accessibility tools such as screen readers are helpful, but they are often not enough for smooth, independent, and fully hands-free interaction.

## Solution

Canvox bridges this gap by enabling voice-based navigation and task execution in Canvas. It uses speech recognition, intent analysis, browser-side execution, and audio feedback to help users complete common tasks more naturally and independently.

## Key Features

- Screen Reader support
- Hands-Free Mode
- Voice Login
- Command Chaining
- Interject Voice Detection
- Enhanced UI from the previous version

## Use Cases

Canvox is useful for:

- Blind and visually impaired students
- Blind and visually impaired teachers
- Hands-free convenience while multitasking
- Users with limited mobility or motor impairment
- General productivity improvements in Canvas workflows

## System Architecture

Canvox follows a voice-driven accessibility pipeline:

1. **Voice Input**  
   The user speaks a command to interact with Canvas.

2. **Speech Recognition / Intent Analysis**  
   The spoken input is transcribed and interpreted using an LLM-assisted pipeline.

3. **Execution**  
   The interpreted task is mapped to browser actions inside Canvas, including navigation, content access, and multi-step workflows.

4. **Audio Feedback**  
   The system confirms actions, reports errors, and asks for clarification when needed.

This hybrid rule-based and LLM-assisted design helps balance reliability for structured tasks with flexibility for natural-language interaction.

## Team

**Team Name:** Null Pointers

**Team Members:**

- Vedansh Tembhre
- Kelly Pierre
- Aarya Shrestha
- Dylan Graham

**Affiliation:**  
HPCC Lab
Department of Computer Science and Engineering  
University of North Texas

## How to Run

1. Clone or download this repository to your local machine.
2. Open Google Chrome and go to `chrome://extensions/`.
3. Turn on **Developer mode** in the top-right corner.
4. Click **Load unpacked**.
5. Select the project folder containing the extension files.
6. The extension should now appear in your Chrome toolbar.
7. Pin the extension for quick access.
8. Open your institution's Canvas page in Chrome and start using Canvox.

## Notes

- This project is currently designed to run as a Chrome extension.
- Some Canvas URL patterns may vary by institution, so additional URL handling may be needed for full compatibility across all schools.

## Conclusion

Canvox demonstrates that a hybrid rule-based and LLM-assisted approach can make Canvas more accessible by improving reliability for common tasks while preserving the flexibility of natural-language voice interaction.

<!-- canvox-spanish-support -->
## Spanish support (Español)

Convox can be used in Spanish. Switch with the **🌐 Español** button in the Convox
panel, or in **chrome://extensions → Convox → Details → Extension options → Language**.

How it works:

- Spanish commands are converted to English by an offline layer
  (`lib/translate.js`) and then run through the **unchanged** English pipeline
  (`lib/actions.js` → `lib/intent.js`).
- Common commands are matched by a built-in Spanish phrase list; everything else
  uses **Chrome's built-in on-device Translator API**. No cloud translation, no
  API keys, no third-party services.
- Convox's spoken replies are translated to Spanish on-device. Canvas page content
  (announcements, messages, page reading) is read in its original language unless
  "Read Canvas page content in Spanish" is turned on.
- Interface text comes from `_locales/en` and `_locales/es` (`chrome.i18n` format).

Requirements and limits:

- Desktop Chrome with the built-in Translator API (Chrome 138+). The Spanish
  language pack downloads **once** (press the language button while online);
  after that translation works offline.
- **Voice input:** Chrome's speech recognition uses Google's online service unless
  on-device recognition is available on that computer (newer Chrome; Convox uses
  it automatically in Spanish mode when installed). Typed commands always work offline.
- Keep **Canvas's own language set to English**. Some features (compose, announcements,
  due-date detection on the page) look for English words in Canvas's interface.
- Run the tests with `npm test`.
