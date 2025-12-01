// actions.js
// Executes actions based on intent (navigation, TTS, memory)

import { intents, detectIntent } from "./intent.js";
import { Memory } from "./memory.js";

const mem = new Memory();

// Inline speak() to avoid dependency on missing tts.js
export function speak(text, opts = {}) {
  try {
    const utter = new SpeechSynthesisUtterance(text);
    utter.rate = opts.rate ?? 1.0;
    utter.pitch = opts.pitch ?? 1.0;
    utter.volume = opts.volume ?? 1.0;
    utter.lang = opts.lang ?? "en-US";
    window.speechSynthesis.cancel(); // Stop any ongoing speech
    window.speechSynthesis.speak(utter);
  } catch (e) {
    console.warn("Speech synthesis error:", e);
  }
}

function findLink(keyword) {
  const links = Array.from(document.querySelectorAll("a, [role='link']"));
  return links.find(l =>
    l.textContent?.toLowerCase().includes(keyword.toLowerCase())
  );
}

async function actOpen(keyword) {
  const link = findLink(keyword);
  if (link) {
    speak(`Opening ${link.textContent.trim()}`);
    link.click();
    return { ok: true };
  } else {
    speak("Sorry, I couldn't find that link.");
    return { ok: false };
  }
}

export async function runAction(intent) {
  switch (intent) {
    case intents.OPEN_GRADES:
      return await actOpen("grade");
    case intents.OPEN_ASSIGNMENTS:
      return await actOpen("assignment");
    case intents.OPEN_COURSES:
      return await actOpen("course");
    case intents.READ_PAGE:
      speak("Reading the page.");
      speak(document.body.innerText.slice(0, 500));
      return { ok: true };
    case intents.READ_NEXT:
      speak("Reading next section.");
      return { ok: true };
    case intents.REPEAT:
      speak("Repeating.");
      return { ok: true };
    case intents.HELP:
      speak("Say: open grades, open assignments, read page, or help.");
      return { ok: true };
    case intents.AFFIRM:
    case intents.DENY:
      speak("Got it.");
      return { ok: true };
    default:
      speak("I didn't catch that. Want me to read the page?");
      await mem.set({ expectingYesNo: true });
      return { ok: false };
  }
}

export async function handleUtterance(text) {
  const context = await mem.get();
  const { intent } = await detectIntent(text, context);
  await mem.set({ lastIntent: intent });
  return await runAction(intent);
}
