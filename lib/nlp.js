// lib/nlp.js
// Lightweight NLP layer for Convox:
// - Inbound: fix common speech-recognition mistakes + normalize commands
// - Outbound: shorten/clean speech so it feels human, not like a screen reader

import { normalize } from "./intent.js";

// ------------------------- Inbound NLP --------------------------------------

// Fix common ASR mistakes. You can extend this with your real logs.
const ASR_FIXES = [
  // hw2 often becomes "s and w 2" / "s&w 2"
  { re: /\b(s\s*&\s*w|s\s+and\s+w)\s*(\d+)\b/gi, to: "hw $2" },
  // "aitch double you two" etc.
  { re: /\b(h\s*w)\s*(\d+)\b/gi, to: "hw $2" },
  // "home work" -> "homework"
  { re: /\bhome\s+work\b/gi, to: "homework" },
  // "course ten forty" -> "course 1040"
  // (basic spoken-number mapping; we keep it conservative)
];

function applyASRFixes(raw) {
  let t = String(raw || "");
  for (const rule of ASR_FIXES) t = t.replace(rule.re, rule.to);
  return t;
}

// Recognize "open assignments of csce 3530" and friends,
// even if the user says it casually.
export function nlpPreprocessUtterance(raw, context = {}) {
  let text = String(raw || "").trim();
  if (!text) return { text: "", meta: { changed: false, notes: ["empty"] } };

  const before = text;

  // Fix ASR weirdness first
  text = applyASRFixes(text);

  // Normalize spacing for patterns like "hw2"
  text = text.replace(/\bhw\s*(\d+)\b/gi, "hw $1");
  text = text.replace(/\bhomework\s*(\d+)\b/gi, "homework $1");

  // If user says “open option one” make it consistent
  text = text.replace(/\b(open\s+)?option\s+(one|two|three|four|five|\d+)\b/gi, (m) => m.replace(/^open\s+/i, ""));

  // If user is inside course-choice mode, and they say "open assignments",
  // add an explicit hint to help your logic route correctly
  // (we don't force it, we just help the parser)
  if (context?.expectingChoice) {
    // keep as-is; your intent layer will require option number
  }

  const changed = before !== text;
  const notes = [];
  if (changed) notes.push(`ASR normalized: "${before}" -> "${text}"`);

  return { text, meta: { changed, notes } };
}

// ------------------------- Outbound NLP -------------------------------------

// Things that waste time when spoken
const STOP_WORD_LINES = [
  /search assignments\.?/i,
  /as you type.*filtered/i,
  /show by/i,
  /not available until/i,
  /points possible/i,
  /no submission.*possible/i,
  /due\s*$/i,
];

// Keep speech concise with a "spoken summary" style
export function nlpStylizeSpeech(raw, opts = {}) {
  const mode = opts.mode || "say"; // "say" | "read" | "list"
  let text = String(raw || "").trim();
  if (!text) return "";

  // Remove repeated whitespace
  text = text.replace(/\s+/g, " ").trim();

  // Remove noisy UI fragments
  for (const re of STOP_WORD_LINES) {
    if (re.test(text)) return ""; // drop whole line if it's just noise
  }

  // If it's very long, summarize heuristically
  if (text.length > (opts.maxChars || 220)) {
    text = heuristicSummarize(text, opts);
  }

  // Make it more human: avoid robotic phrasing
  text = text
    .replace(/\bI couldn’t\b/gi, "I can't")
    .replace(/\bI could not\b/gi, "I can't")
    .replace(/\bDo you want me to\b/gi, "Want me to")
    .replace(/\bShould I\b/gi, "Want me to")
    .replace(/\bI didn’t catch that\b/gi, "I missed that")
    .replace(/\bReading the (first|next) section\b/gi, "Alright—here's the next part");

  // Optional: add light friendliness without being chatty
  if (mode === "say") {
    text = text.replace(/\.$/, "");
    text = text + ".";
  }

  return text;
}

function heuristicSummarize(text, opts = {}) {
  // For reading pages, we want:
  // - a short headline-like summary
  // - then maybe 1–3 key items (e.g., assignments list titles)
  const max = opts.maxChars || 220;

  // Try: pull assignment titles from Canvas assignments page text blobs
  const titles = extractLikelyTitles(text).slice(0, 3);
  if (titles.length) {
    const lead = opts.lead || "Here's what I found:";
    const joined = titles.join(", ");
    const out = `${lead} ${joined}.`;
    return out.length <= max ? out : out.slice(0, max - 1) + "…";
  }

  // Fallback: first sentence-ish chunk
  const cut = text.slice(0, max);
  const lastP = Math.max(cut.lastIndexOf("."), cut.lastIndexOf("!"), cut.lastIndexOf("?"));
  if (lastP > 80) return cut.slice(0, lastP + 1);
  return cut + "…";
}

function extractLikelyTitles(text) {
  // Very simple: look for patterns like:
  // "Quiz 1", "Project 1 Submission", "Final Reflection Report"
  // We also try to split by common separators and pick capitalized chunks.
  const raw = text
    .replace(/\bUpcoming assignments\b/gi, "")
    .replace(/\bAssignment\b/gi, "")
    .replace(/\bQuiz\b/gi, "Quiz")
    .trim();

  const parts = raw.split(/(?:\s{2,}|\n|•|-|\||:)/).map((s) => s.trim()).filter(Boolean);

  const good = [];
  for (const p of parts) {
    if (p.length < 3) continue;
    if (p.length > 60) continue;
    // prefer titlecase-ish strings
    const hasLetter = /[a-z]/i.test(p);
    const hasDigit = /\d/.test(p);
    const looksTitle = /^[A-Z]/.test(p) || hasDigit;
    if (hasLetter && looksTitle) good.push(p);
  }
  // de-dupe
  return Array.from(new Set(good));
}

// ----------------------- Output “reading mode” helpers ----------------------

// When you read a page section, instead of dumping raw text,
// convert it into a quick spoken summary + optional "say more" prompt.
export function makeSpokenSection(rawSectionText) {
  const cleaned = rawSectionText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !STOP_WORD_LINES.some((re) => re.test(l)));

  if (!cleaned.length) return "Nothing important in this part.";

  // If it looks like an assignments list, summarize items
  const joined = cleaned.join(" ");
  const titles = extractLikelyTitles(joined).slice(0, 5);

  if (titles.length) {
    const head = "Upcoming items:";
    const list = titles.slice(0, 3).join(", ");
    const tail = titles.length > 3 ? "Want more?" : "";
    return `${head} ${list}. ${tail}`.trim();
  }

  // Otherwise: speak first meaningful line or two
  const short = cleaned.slice(0, 2).join(". ");
  return nlpStylizeSpeech(short, { maxChars: 220, mode: "read", lead: "Summary:" });
}
