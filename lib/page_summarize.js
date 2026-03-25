// lib/page_summarize.js
// Concise page summarization with:
// 1) Chrome's on-device Summarizer API when available (no bundled model)
// 2) A fast heuristic fallback when the API isn't available
//
// This module is safe for MV3 content scripts and does not perform network
// requests.

"use strict";

let _session = null;
let _sessionKey = "";

const STOPWORDS = new Set([
  "a","an","and","are","as","at","be","but","by","for","from","has","have","he","her","his","i","if","in","into","is","it","its","me","my","not","of","on","or","our","she","so","that","the","their","them","then","there","these","they","this","to","us","was","we","were","what","when","where","which","who","will","with","you","your",
]);

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function splitSentences(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function cleanInputText(raw) {
  let t = String(raw || "");
  // strip urls
  t = t.replace(/https?:\/\/\S+/gi, "");
  // strip common boilerplate
  t = t.replace(/\bLinks to an external site\.?\b/gi, "");
  t = t.replace(/\bThis topic is closed for comments\.?\b/gi, "");
  t = t.replace(/\s+/g, " ").trim();
  // cap for perf
  const MAX = 20000;
  if (t.length > MAX) t = t.slice(0, MAX);
  return t;
}

function normalizeOutput(s) {
  let out = String(s || "").trim();
  if (!out) return "";

  // Convert bullet output to short sentences
  if (/^\s*[-*]\s+/m.test(out)) {
    out = out
      .split(/\r?\n/)
      .map((l) => l.replace(/^\s*[-*]\s+/, "").trim())
      .filter(Boolean)
      .join(". ");
  }

  out = out.replace(/\s+/g, " ").trim();
  if (!/[.!?]$/.test(out)) out += ".";
  return out;
}

function heuristicSummary(text, maxSentences = 2) {
  const sentences = splitSentences(text).filter((s) => s.length > 25);
  if (!sentences.length) return "";

  const pool = sentences.slice(0, 200);
  const freq = new Map();

  for (const s of pool) {
    const words = s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w));
    for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);
  }

  const scored = pool.map((s, idx) => {
    const words = s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w));

    let score = 0;
    for (const w of words) score += freq.get(w) || 0;
    score = score / Math.sqrt(Math.max(1, words.length));

    // boost actionable lines
    if (/\b(register|attend|due|bonus|credit|grade|deadline|meeting|location|room|bring|submit)\b/i.test(s)) {
      score *= 1.2;
    }

    return { s, idx, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored
    .slice(0, clamp(maxSentences, 1, 3))
    .sort((a, b) => a.idx - b.idx);

  return top.map((x) => x.s).join(" ");
}

async function getSession() {
  // Summarizer API is optional. If missing, return null.
  if (!("Summarizer" in self)) return null;

  const key = "shared:v1";
  if (_session && _sessionKey === key) return _session;

  try {
    // availability() can be: "available", "unavailable", "downloadable"
    const avail = await self.Summarizer.availability?.();
    if (avail !== "available" && avail !== "downloadable") return null;

    _session = await self.Summarizer.create({
      type: "key-points",
      format: "plain-text",
      length: "short",
    });
    _sessionKey = key;
    return _session;
  } catch {
    return null;
  }
}

/**
 * Summarize arbitrary text for speech.
 * @param {string} raw
 * @param {{ maxSentences?: number }} opts
 */
export async function summarizeTextForSpeech(raw, opts = {}) {
  const maxSentences = clamp(Number(opts.maxSentences ?? 2), 1, 3);
  const cleaned = cleanInputText(raw);
  if (!cleaned) return "";

  // If the input is already short, just return first 1-2 sentences.
  if (cleaned.length < 240) {
    return normalizeOutput(splitSentences(cleaned).slice(0, maxSentences).join(" "));
  }

  const session = await getSession();
  if (session) {
    try {
      const out = await session.summarize(cleaned);
      const normalized = normalizeOutput(out);
      if (normalized) return normalized;
    } catch {
      // fall through
    }
  }

  return normalizeOutput(heuristicSummary(cleaned, maxSentences));
}
