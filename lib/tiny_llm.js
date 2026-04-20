// lib/tiny_llm.js
// Ollama-backed LLM utilities for Convox.
// - MV3-safe (no npm bare imports)
// - Intent routing + small talk/general Q&A

const OLLAMA_URL = "http://localhost:11434/api/generate";
const DEFAULT_OLLAMA_MODEL = "llama3.2"; // change to what you have in `ollama list`

async function ollamaOneShot(prompt, { model = DEFAULT_OLLAMA_MODEL, temperature = 0.2 } = {}) {
  const res = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      options: { temperature }
    })
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Ollama failed (${res.status}): ${txt.slice(0, 200)}`);
  }

  const data = await res.json();
  return (data?.response || "").trim();
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    // Try to recover if model wrapped JSON in text
    const m = String(s || "").match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch { return null; }
  }
}

function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export async function llmClassifyIntent({ utterance, allowIntents, context }) {
  const u = String(utterance || "").trim();
  if (!u) return null;

  const allow = Array.isArray(allowIntents) ? allowIntents : [];
  const ctx = context && typeof context === "object" ? context : {};

  // Keep prompt strict: JSON only.
  const prompt = `
You are Convox, a voice assistant for blind students using Canvas.
Task: classify the user's utterance into ONE intent from the allowed list, and extract slots.

Return ONLY valid JSON with this schema:
{
  "intent": "<one of allowed intents>",
  "confidence": <number 0 to 1>,
  "slots": { ... },
  "reason": "<short>"
}

Rules:
- Choose the closest intent even if wording is different.
- If it's greeting/thanks/how-are-you/small talk -> "SMALL_TALK".
- If it's a general question not requiring navigation (e.g., "what can you do", "help me understand", "how do I") -> "QA_GENERAL".
- If unsure -> "UNKNOWN" with confidence <= 0.4.
- Slots:
  - courseNum: 4-digit string if present (e.g., 5210)
  - section: short string like "assignments", "grades", "modules"
  - target: navigation target phrase (e.g., "inbox", "calendar")
  - q: search query (e.g., "HW 2", "final reflection report")

Allowed intents:
${allow.map(x => `- ${x}`).join("\n")}

Context:
${JSON.stringify({
  expectingChoice: !!ctx.expectingChoice,
  expectingYesNo: !!ctx.expectingYesNo,
  lastIntent: ctx.lastIntent || null,
  activeCourseName: ctx.activeCourseName || null,
  url: location?.href || ""
}, null, 2)}

User utterance:
${u}
`.trim();

  try {
    const out = await ollamaOneShot(prompt, { temperature: 0.1 });
    const obj = safeJsonParse(out);
    if (!obj || typeof obj !== "object") return null;

    const intent = String(obj.intent || "").trim();
    if (!allow.includes(intent)) return null;

    const confidence = clamp01(obj.confidence);
    const slots = obj.slots && typeof obj.slots === "object" ? obj.slots : {};
    const reason = String(obj.reason || "llm").slice(0, 120);

    return { intent, confidence, slots, reason };
  } catch (e) {
    console.warn("[tiny_llm] classifyIntent failed:", e);
    return null;
  }
}

export async function llmChatGeneral({ utterance, context, maxSentences = 2 }) {
  const u = String(utterance || "").trim();
  if (!u) return "";

  const ctx = context && typeof context === "object" ? context : {};

  const prompt = `
You are Convox, a friendly voice assistant for blind students using Canvas.
Answer the user's message conversationally.

Constraints:
- Keep it short: max ${maxSentences} sentences.
- If user asks "what can you do" or similar: give 3-5 concrete examples.
- If user asks about assignments/due/grades/courses: suggest the exact command they can say next.
- Do not mention DOM, JSON, modules, extensions, or "LLM".
- Avoid filler.

Context:
${JSON.stringify({
  url: location?.href || "",
  lastIntent: ctx.lastIntent || null,
  activeCourseName: ctx.activeCourseName || null
}, null, 2)}

User:
${u}
`.trim();

  try {
    return await ollamaOneShot(prompt, { temperature: 0.4 });
  } catch (e) {
    console.warn("[tiny_llm] chat fallback:", e);
    return "";
  }
}

// Existing helpers (kept)
function buildRewritePrompt(text) {
  return `Rewrite the following assistant message to be short, friendly, and voice-first for a blind user.

Rules:
- Keep it under 1 sentence if possible.
- Remove UI noise, repeated labels, and unnecessary numbers unless essential.
- Don’t sound like a screen reader.

Message:
${text}`.trim();
}

function buildSummaryPrompt(text) {
  return `Summarize the following Canvas page content for a blind user.

Rules:
- 3–6 bullets max.
- Keep only actionable items (titles, due dates if present).
- Remove boilerplate.

Content:
${text}`.trim();
}

export async function llmRewriteForSpeech(text, { model } = {}) {
  const t = String(text || "").trim();
  if (!t) return t;

  try {
    const out = await ollamaOneShot(buildRewritePrompt(t), { model });
    return out || t;
  } catch {
    return t;
  }
}

export async function llmSummarizeForSpeech(text, { model } = {}) {
  const t = String(text || "").trim();
  if (!t) return t;

  try {
    const out = await ollamaOneShot(buildSummaryPrompt(t), { model });
    return out || t;
  } catch {
    return t;
  }
}

// -----------------------------------------------------------------------------
// Single best version: llmAnswerQuestion (used by actions.js)
// -----------------------------------------------------------------------------
function buildAnswerPrompt({ question, tz, todayISO, items }) {
  return `You are a helpful human assistant helping a blind student with Canvas.
Answer the user's question using ONLY the provided items.
Be brief, voice-first, and concrete.

Rules:
- 1–3 sentences total.
- If there are items: mention the count and the next 1–3 items (title + due time if available).
- If there are none: clearly say none.
- Ask at most one helpful follow-up question (optional).
- Do NOT mention “DOM”, “API”, “snapshot”, or “JSON”.
- Timezone: ${tz}
- Today date (ISO): ${todayISO}

User question:
${question}

Items (already relevant):
${JSON.stringify(items, null, 2)}
`.trim();
}

export async function llmAnswerQuestion(
  { question, items, tz = "America/Chicago", todayISO = new Date().toISOString().slice(0, 10) },
  { model } = {}
) {
  const q = String(question || "").trim();
  if (!q) return "";

  try {
    const out = await ollamaOneShot(
      buildAnswerPrompt({ question: q, tz, todayISO, items: items || [] }),
      { model, temperature: 0.2 }
    );
    return (out || "").trim();
  } catch (e) {
    console.warn("[tiny_llm] llmAnswerQuestion fallback:", e);
    return "";
  }
}
