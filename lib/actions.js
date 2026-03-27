// lib/actions.js
// PERSON B — Action router for detected intents.
// Depends on intent enums + Memory from lib/intent.js

import { intents, Memory, normalize } from "./intent.js";
import { fetchPlannerItems, fetchUserTodo, normalizeCanvasItem } from "./canvas_api.js";
import { buildSnapshot } from "./snapshot.js";
// NOTE: We intentionally avoid any "tiny LLM" or Ollama dependency.
// Summaries use Chrome's on-device Summarizer API when available, otherwise a
// fast heuristic fallback.
import { extractPageMainText } from "./page_text.js";
import { summarizeTextForSpeech } from "./page_summarize.js";

// =============================================================================
// GLOBAL GUARDS (prevents "Identifier already declared" when injected twice)
// =============================================================================
const __CONVOX = (globalThis.__CONVOX ||= {});
__CONVOX.actions ||= {};

// Small utility (was missing but used in multiple places)
function delay(ms = 0) {
	return new Promise((r) => setTimeout(r, ms));
}


// =============================================================================
// 0) NLP-lite layer (inbound + outbound)
// =============================================================================

function normalizeASR(raw = "") {
	let u = String(raw || "").trim();

	// --- Existing HW / ASR fixes ---
	u = u.replace(/\b(s\s*&\s*w|s\s+and\s+w|s\s+w)\s*(\d+)\b/gi, "HW $2");
	u = u.replace(/\b(s\s*&\s*w|s\s+and\s+w|s\s+w)\b/gi, "HW");
	u = u.replace(/\bhome\s*work\b/gi, "homework");
	u = u.replace(/\bh\s*w\s*(\d+)\b/gi, "HW $1");
	u = u.replace(/\bhomework\s*(\d+)\b/gi, "HW $1");
	u = u.replace(/\bhw\s*(\d+)\b/gi, "HW $1");

	// --- NEW: common ASR mistakes -> "course" ---
	u = u.replace(/\b(coir|coors|corps|cours|coure|cource|cors|cores|core)\b/gi, "course");
	u = u.replace(/\bclass\b/gi, "course");
	const wordToDigit = {
		one: "1",
		two: "2",
		three: "3",
		four: "4",
		five: "5",
		six: "6",
		seven: "7",
		eight: "8",
		nine: "9",
		ten: "10",
	};

	u = u.replace(/\b(sprint)\s+(one|two|three|four|five|six|seven|eight|nine|ten)\b/gi, (_, a, b) => {
		return `${a} ${wordToDigit[String(b).toLowerCase()] || b}`;
	});

	// final whitespace cleanup
	u = u.replace(/\s+/g, " ").trim();
	return u;
}

const NOISE_PATTERNS = [
	/search assignments/i,
	/as you type.*filtered/i,
	/show by/i,
	/not available until/i,
	/points possible/i,
	/no submission/i,
	/\b-\s*\/\s*\d+\s*pts\b/i,
];

function isNoisyLine(line) {
	return NOISE_PATTERNS.some((re) => re.test(line));
}

function extractLikelyTitles(text) {
	const parts = text
		.replace(/\bUpcoming assignments\b/gi, "")
		.replace(/\bAssignments\b/gi, "")
		.split(/(?:\n|•|-|\||:|\t)/)
		.map((s) => s.trim())
		.filter(Boolean);

	const good = [];
	for (const p of parts) {
		if (p.length < 3 || p.length > 70) continue;
		if (isNoisyLine(p)) continue;
		const hasLetter = /[a-z]/i.test(p);
		const looksTitle = /^[A-Z]/.test(p) || /\d/.test(p);
		if (hasLetter && looksTitle) good.push(p.replace(/\s+/g, " "));
	}
	return Array.from(new Set(good));
}

function stylizeSpeech(raw, opts = {}) {
	const mode = opts.mode || "say";
	let t = String(raw ?? "").trim();
	if (!t) return "";

	if (t.length < 200 && isNoisyLine(t)) return "";

	t = t.replace(/\s+/g, " ").trim();

	t = t
		.replace(/\bI couldn’t\b/gi, "I can't")
		.replace(/\bI could not\b/gi, "I can't")
		.replace(/\bDo you want me to\b/gi, "Want me to")
		.replace(/\bShould I\b/gi, "Want me to")
		.replace(/\bI didn’t catch that\b/gi, "I missed that");

	const maxChars = opts.maxChars ?? (mode === "read" ? 240 : 300);

	if (t.length > maxChars) {
		const titles = extractLikelyTitles(t).slice(0, 3);
		if (titles.length) {
			const lead = opts.lead || "Quick summary:";
			t = `${lead} ${titles.join(", ")}.`;
		} else {
			t = t.slice(0, maxChars - 1) + "…";
		}
	}

	if (mode === "say" && !/[.!?]$/.test(t)) t += ".";
	return t;
}

function makeSpokenSection(rawSectionText) {
	const lines = String(rawSectionText || "")
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.filter((l) => !isNoisyLine(l));

	if (!lines.length) return "Nothing important in this part.";

	const joined = lines.join(" ");
	const titles = extractLikelyTitles(joined);

	if (titles.length) {
		const top = titles.slice(0, 3).join(", ");
		return `Upcoming items: ${top}.`;
	}

	return stylizeSpeech(lines.slice(0, 2).join(". "), { mode: "read", maxChars: 220 });
}

// =============================================================================
// 1) Speech helpers
// =============================================================================
function speakCourseShort(label = "", href = "") {
	// Try to extract course number like 3214, 1040, 5210
	const m =
		label.match(/\b\d{4}\b/) ||
		href.match(/\b\d{4}\b/);

	if (m) return `course ${m[0]}`;

	// Fallback: first 3 words only
	return label
		.replace(/\s+/g, " ")
		.split(" ")
		.slice(0, 3)
		.join(" ");
}
async function speakNav(msg, opts = {}) {
	// opts.always = true -> speak even during chain
	const st = await mem.get();
	const isChained = st?.plan?.kind === "CHAINED_COMMANDS";
	if (isChained && !opts.always) return; // suppress during chain
	return await speak(msg, opts);
}

function shouldBypassNlpSpeech(text, opts = {}) {
	if (opts.raw) return true;
	const s = String(text || "");
	if (/\b1:\s|\b2:\s|\b3:\s|\b4:\s|\b5:\s|\b6:\s|\b7:\s|\b8:\s/.test(s)) return true;
	if (/say the number|say option|option \d/i.test(s)) return true;
	return false;
}

export function speak(text, opts = {}) {
	return new Promise((resolve) => {
		try {
			const rawText = String(text ?? "").trim();
			if (!rawText) return resolve();

			const cleaned = shouldBypassNlpSpeech(rawText, opts) ? rawText : stylizeSpeech(rawText, opts);
			if (!cleaned) return resolve();

			const utter = new SpeechSynthesisUtterance(cleaned);
			utter.rate = opts.rate ?? 1.0;
			utter.pitch = opts.pitch ?? 1.0;
			utter.volume = opts.volume ?? 1.0;
			utter.lang = opts.lang ?? "en-US";

			utter.onend = () => resolve();
			utter.onerror = () => resolve();

			window.speechSynthesis.cancel();
			window.speechSynthesis.speak(utter);
		} catch (e) {
			console.warn("speech error:", e);
			resolve();
		}
	});
}

async function speakChoiceOptions() {
	const st = await mem.get();
	const opts = Array.isArray(st.choiceOptions) ? st.choiceOptions : [];
	if (!opts.length) {
		await speak("No options to repeat.", { mode: "say" });
		return;
	}
	let msg = "Options: ";
	opts.slice(0, 8).forEach((o, i) => {
		msg += `${i + 1}: ${o.label}. `;
	});
	msg += "Say the number, like: option 1.";
	await speak(msg, { raw: true });
}

// =============================================================================
// 2) DOM utils
// =============================================================================

function allLinks() {
	return Array.from(document.querySelectorAll("a, [role='link']"));
}

function scoreLink(el, keywords = [], hrefHints = []) {
	const text = (el.textContent || "").trim().toLowerCase();
	const href = (el.getAttribute?.("href") || el.href || "").toLowerCase();
	let score = 0;

	for (const k of keywords) {
		if (!k) continue;
		if (text.includes(k)) score += 2.5;
		if (href.includes(k)) score += 1.2;
	}
	for (const h of hrefHints) {
		if (!h) continue;
		if (href.includes(h)) score += 1.5;
	}

	const rect = el.getBoundingClientRect?.();
	if (rect && rect.width > 40 && rect.height > 16) score += 0.4;

	if (el.closest?.("#section-tabs, #left-side, .ic-app-nav")) score += 0.6;

	return score;
}

function findBestLink({ keywords = [], hrefHints = [], minScore = 2.0 } = {}) {
	const links = allLinks();
	let best = null;
	let bestScore = 0;

	for (const el of links) {
		const s = scoreLink(el, keywords, hrefHints);
		if (s > bestScore) {
			best = el;
			bestScore = s;
		}
	}

	if (best && bestScore >= minScore) {
		return { el: best, score: bestScore };
	}
	return null;
}

function getReadableSections() {
	const selectors = [
		"main h1, main h2, main h3, main h4",
		"article h1, article h2, article h3, article h4",
		"[role='main'] h1, [role='main'] h2, [role='main'] h3, [role='main'] h4",
		".ic-Layout-main h1, .ic-Layout-main h2, .ic-Layout-main h3, .ic-Layout-main h4",
	];
	const heads = Array.from(document.querySelectorAll(selectors.join(", ")));
	if (heads.length === 0) {
		const blocks = Array.from(document.querySelectorAll("main p, article p, [role='main'] p"));
		return blocks.map((b, i) => ({ id: b.id || `p-${i}`, el: b }));
	}
	return heads.map((h, i) => ({ id: h.id || `sec-${i}`, el: h }));
}

// =============================================================================
// 3) Memory helpers
// =============================================================================

const mem = new Memory();

async function remember(patch) {
	return await mem.set(patch);
}

function clickAndNavigate(el) {
	try {
		el.setAttribute("tabindex", "-1");
		el.focus({ preventScroll: false });
		el.click();
	} catch (e) {
		el?.click?.();
	}
}

// =============================================================================
// 4) State hygiene
// =============================================================================

async function clearStickyModes() {
	await mem.set({
		expectingChoice: false,
		choiceOptions: null,
		expectingYesNo: false,
		pendingAction: null,
		composeFlow: null,
		composeDraft: null,
	});
}

// =============================================================================
// 5) Course-context helpers (robust scoping)
// =============================================================================

function getCourseIdFromHref(href = "") {
	const h = String(href || "");
	const m = h.match(/\/courses\/(\d+)(?:\/|$|\?|\#)/i);
	return m ? m[1] : null;
}

function getActiveCourseId(state) {
	// priority: remembered active course href
	const idA = getCourseIdFromHref(state?.activeCourseHref || "");
	if (idA) return idA;

	// fallback: current location
	const idB = getCourseIdFromHref(location.pathname || "");
	if (idB) return idB;

	return null;
}

function findCourseScopedNavLink(courseId, sectionSlug, keywords = []) {
	if (!courseId || !sectionSlug) return null;

	const wanted = `/courses/${courseId}/${sectionSlug}`.toLowerCase();
	const links = allLinks();

	// Prefer exact href match (course-scoped), then score ties with keywords
	let best = null;
	let bestScore = 0;

	for (const el of links) {
		const href = (el.getAttribute?.("href") || el.href || "").toLowerCase();
		if (!href) continue;
		if (!href.includes(wanted)) continue;

		const score = 4.0 + scoreLink(el, keywords, [wanted]); // strong bias toward scoped link
		if (score > bestScore) {
			best = el;
			bestScore = score;
		}
	}

	return best;
}

// =============================================================================
// 6) Multi-step plan runner (persists across navigation)
//    IMPORTANT CHANGE: no persistent lock in Memory (only in-page mutex)
// =============================================================================

const PLAN_KEY = "plan";

const NAV_INTENTS = new Set([
	intents.OPEN_DASHBOARD,
	intents.OPEN_COURSES,
	intents.OPEN_ASSIGNMENTS,
	intents.OPEN_GRADES,
	intents.OPEN_MODULES,
	intents.OPEN_QUIZZES,
	intents.OPEN_FILES,
	intents.GO_BACK,
	intents.NAVIGATE_TO,
	intents.OPEN_COURSE_BY_NUMBER,
	intents.OPEN_COURSE_SECTION,
	intents.OPEN_ASSIGNMENT_QUERY,
	intents.CHOOSE_OPTION,
	intents.OPEN_ASSIGNMENTS_FOR_COURSE,
	intents.OPEN_ASSIGNMENT_FOR_COURSE,
	intents.OPEN_HOME,
	"OPEN_INBOX",
	"COMPOSE_MESSAGE",

]);

async function setPlan(steps, meta = {}) {
  // ✅ Kill any stale resume payload from a previous chain
  try { __CONVOX.actions.clearResumePlan?.(); } catch {}
  await mem.set({ [PLAN_KEY]: { id: Date.now(), i: 0, steps, ...meta } });
}


async function clearPlan() {
	await mem.set({ [PLAN_KEY]: null });
}

// =============================================================================
// 7) Plan "until" helpers (CONDITION barrier)
// =============================================================================

function planUntilSatisfied(until, state) {
	if (!until) return true;

	if (until.type === "PATH_INCLUDES") {
		return String(location.pathname || "").includes(String(until.value || ""));
	}
	if (until.type === "COURSE_NUM") {
	const want = String(until.value || "").trim();
	const have = String(state?.activeCourseNum || "").trim();
	return want && have && want === have;
	}


	if (until.type === "COURSE_ID") {
		// Special: "__ANY_COURSE__" means "any course page"
		if (String(until.value) === "__ANY_COURSE__") {
			return /\/courses\/\d+/.test(String(location.pathname || ""));
		}
		const active = getActiveCourseId(state);
		return active && String(active) === String(until.value);
	}

	if (until.type === "ANY_COURSE_PAGE") {
		return /\/courses\/\d+/.test(String(location.pathname || ""));
	}
	if (until.type === "COURSE_REF") {
		const wantNum = String(until.value?.num || "");
		const wantDept = String(until.value?.dept || "");

		const haveNum = String(state?.activeCourseCode || "");
		const haveDept = String(state?.activeCourseDept || "");

		if (!wantNum) return false;

		// If we know dept on both sides, require both match
		if (wantDept && haveDept) return wantNum === haveNum && wantDept === haveDept;

		// Otherwise fall back to number-only match (works for most schools)
		return wantNum === haveNum;
		}


	return true;
}

// =============================================================================
// 8) In-page plan mutex + resume runner  (FIXED for chained commands)
// =============================================================================

const __PLAN_MUTEX_KEY = "__convox_plan_mutex_v1";
const __PLAN_RESUME_KEY = "__convox_plan_resume_v1";

// --- Guarded helper definitions (avoid redeclare crash) ----------------------
if (!__CONVOX.actions.acquirePlanMutex) {
  __CONVOX.actions.acquirePlanMutex = function acquirePlanMutex(ttlMs = 15000) {
    try {
      const now = Date.now();
      const cur = JSON.parse(sessionStorage.getItem(__PLAN_MUTEX_KEY) || "null");

      // If lock came from a different page, allow takeover immediately.
      // (Old page may unload before finally{} can release.)
      if (cur && cur.href && cur.href !== location.href) {
        sessionStorage.setItem(__PLAN_MUTEX_KEY, JSON.stringify({ ts: now, href: location.href }));
        return true;
      }

      // Same-page lock: respect TTL
      if (cur && now - cur.ts < ttlMs) return false;

      sessionStorage.setItem(__PLAN_MUTEX_KEY, JSON.stringify({ ts: now, href: location.href }));
      return true;
    } catch {
      return true; // fail-open
    }
  };
}

if (!__CONVOX.actions.releasePlanMutex) {
  __CONVOX.actions.releasePlanMutex = function releasePlanMutex() {
    try { sessionStorage.removeItem(__PLAN_MUTEX_KEY); } catch {}
  };
}

if (!__CONVOX.actions.saveResumePlan) {
  __CONVOX.actions.saveResumePlan = function saveResumePlan(planSteps, idx, meta = {}) {
    try {
      sessionStorage.setItem(
        __PLAN_RESUME_KEY,
        JSON.stringify({ plan: planSteps, idx, meta, ts: Date.now() })
      );
    } catch {}
  };
}

if (!__CONVOX.actions.loadResumePlan) {
  __CONVOX.actions.loadResumePlan = function loadResumePlan(maxAgeMs = 120000) {
    try {
      const v = JSON.parse(sessionStorage.getItem(__PLAN_RESUME_KEY) || "null");
      if (!v) return null;
      if (Date.now() - (v.ts || 0) > maxAgeMs) return null;
      return v;
    } catch {
      return null;
    }
  };
}

if (!__CONVOX.actions.clearResumePlan) {
  __CONVOX.actions.clearResumePlan = function clearResumePlan() {
    try { sessionStorage.removeItem(__PLAN_RESUME_KEY); } catch {}
  };
}

if (!__CONVOX.actions.waitForUrlChange) {
  __CONVOX.actions.waitForUrlChange = function waitForUrlChange(startHref, timeoutMs = 8000) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const timer = setInterval(() => {
        if (location.href !== startHref) {
          clearInterval(timer);
          resolve(true);
        } else if (Date.now() - t0 > timeoutMs) {
          clearInterval(timer);
          resolve(false);
        }
      }, 150);
    });
  };
}

if (!__CONVOX.actions.waitForCanvasNavReady) {
  __CONVOX.actions.waitForCanvasNavReady = async function waitForCanvasNavReady(timeoutMs = 12000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const ok =
        document.querySelector("#content") ||
        document.querySelector(".ic-app-main-content") ||
        document.querySelector("main") ||
        document.querySelector("h1");
      if (ok) return true;
      await delay(150);
    }
    return false;
  };
}
// =============================================================================
// Queue resume persistence (navigation-safe backup)
// =============================================================================
const __QUEUE_RESUME_KEY = "__convox_queue_resume_v1";

if (!__CONVOX.actions.saveResumeQueue) {
  __CONVOX.actions.saveResumeQueue = function saveResumeQueue(queueSteps, meta = {}) {
    try {
      sessionStorage.setItem(
        __QUEUE_RESUME_KEY,
        JSON.stringify({ queue: queueSteps, meta, ts: Date.now() })
      );
    } catch {}
  };
}

if (!__CONVOX.actions.loadResumeQueue) {
  __CONVOX.actions.loadResumeQueue = function loadResumeQueue(maxAgeMs = 180000) {
    try {
      const v = JSON.parse(sessionStorage.getItem(__QUEUE_RESUME_KEY) || "null");
      if (!v?.queue) return null;
      if (Date.now() - (v.ts || 0) > maxAgeMs) return null;
      return v;
    } catch {
      return null;
    }
  };
}

if (!__CONVOX.actions.clearResumeQueue) {
  __CONVOX.actions.clearResumeQueue = function clearResumeQueue() {
    try {
      sessionStorage.removeItem(__QUEUE_RESUME_KEY);
    } catch {}
  };
}

// --- Plan runner -------------------------------------------------------------
// This is the missing piece: executes plan steps sequentially,
// and **persists resume state before navigation**.
async function runPlan(planSteps, { startIdx = 0, meta = {} } = {}) {
  if (!Array.isArray(planSteps) || !planSteps.length) {
    await clearPlan();
    __CONVOX.actions.clearResumePlan();
    return { ok: true, message: "Empty plan" };
  }

  // pull latest plan state (if it exists) for barriers like activeCourseHref
  let state = await mem.get();

  for (let i = startIdx; i < planSteps.length; i++) {
	await __CONVOX.actions.waitForCanvasNavReady();

    const step = planSteps[i];
    if (!step?.intent) continue;

    state = await mem.get();

    // barrier: if already satisfied, skip without doing anything
    if (step.until && planUntilSatisfied(step.until, state)) {
      // advance pointer in Memory (best-effort)
      const st = await mem.get();
      if (st?.plan) await mem.set({ plan: { ...st.plan, i: i + 1 } });
      continue;
    }

    // Run the step
    const beforeHref = location.href;
    const res = await runAction(step.intent, step.slots || {});
	// ✅ If this step has a barrier, wait a bit for SPA nav to complete
	if (step.until) {
	const start = Date.now();
	while (Date.now() - start < 5000) {
		state = await mem.get();
		if (planUntilSatisfied(step.until, state)) break;
		await new Promise(r => setTimeout(r, 120));
	}
	}

    // Update plan pointer in Memory (best-effort)
    const st2 = await mem.get();
    if (st2?.plan) await mem.set({ plan: { ...st2.plan, i: i + 1 } });

    // If this is a navigation step, we must persist resume **before** page unload
    const isNav = NAV_INTENTS.has(step.intent);

	if (isNav) {
	// Save resume in case the page unloads
	__CONVOX.actions.saveResumePlan(planSteps, i + 1, meta);

	// ✅ If Canvas SPA changes the URL without unloading, don’t stop the plan.
	const changed = await __CONVOX.actions.waitForUrlChange(beforeHref, 3500);
	if (changed) {
		await __CONVOX.actions.waitForCanvasNavReady(12000);

		// We did NOT unload, so don’t leave stale resume state behind
		__CONVOX.actions.clearResumePlan();

		// Continue to next step on the same script run
		continue;
	}

	// If URL didn’t change quickly, assume real navigation/unload will happen
	return { ok: true, message: "Nav step executed; will resume on next page", nav: true, last: res };
	}




    // Non-nav step: if it failed, stop chain (don’t blindly continue)
    if (!res?.ok) {
      __CONVOX.actions.clearResumePlan();
      return { ok: false, message: "Plan step failed; stopping", failedStep: step, last: res };
    }
  }

  // Completed all steps
  __CONVOX.actions.clearResumePlan();
  await clearPlan();
  return { ok: true, message: "Plan completed" };
}

// Prevent concurrent resume attempts
let __resumePlanRunning = false;

async function resumePlanIfAny() {
  if (__resumePlanRunning) return;
  __resumePlanRunning = true;

  try {
    // ✅ Respect suppression (prevents ghost resuming after back/manual nav)
    const st0 = await mem.get();
    if (isAutoResumeSuppressed(st0)) return;

    if (!__CONVOX.actions.acquirePlanMutex()) return;

    await __CONVOX.actions.waitForCanvasNavReady();

    const payload = __CONVOX.actions.loadResumePlan();
    if (payload?.plan && typeof payload.idx === "number") {
      const { plan, idx, meta } = payload;
      return await runPlan(plan, { startIdx: idx, meta: meta || {} });
    }

    const st = await mem.get();
    const p = st?.plan;
    if (!p?.steps?.length) return;

    return await runPlan(p.steps, { startIdx: Number(p.i || 0), meta: p || {} });
  } finally {
    __CONVOX.actions.releasePlanMutex();
    __resumePlanRunning = false;
  }
}


// =============================================================================
// 9) Auto-resume suppression (prevents ghost actions after manual nav)
// =============================================================================

const SUPPRESS_KEY = "suppressResumeUntil";

async function suppressAutoResume(ms = 1200) {
	await mem.set({ [SUPPRESS_KEY]: Date.now() + ms });
}

function isAutoResumeSuppressed(state) {
	const until = Number(state?.[SUPPRESS_KEY] || 0);
	return until && Date.now() < until;
}

// =============================================================================
// 10) Choice mode
// =============================================================================

async function askChoice(options, prompt) {
	await mem.set({
		expectingChoice: true,
		choiceOptions: options.map((o) => ({ label: o.label, href: o.href })),
		expectingYesNo: false,
		pendingAction: null,
	});

	let msg = prompt + " ";
	options.slice(0, 8).forEach((o, i) => {
		msg += `${i + 1}: ${o.label}. `;
	});
	msg += "Say the number, like: option 1.";

	await speak(msg, { raw: true });
}

function ordinalToIdx(x) {
	const t = String(x || "").toLowerCase().trim();

	const cleaned = t
		.replace(/^(open|choose|select)\s+/g, "")
		.replace(/\b(option|number|choice)\b/g, "")
		.replace(/[^\w\s]/g, " ")
		.replace(/\s+/g, " ")
		.trim();

	const digit = cleaned.match(/\b(\d+)\b/);
	if (digit) {
		const n = parseInt(digit[1], 10);
		return Number.isFinite(n) ? n - 1 : null;
	}

	const map = {
		first: 0,
		second: 1,
		third: 2,
		fourth: 3,
		fifth: 4,
		sixth: 5,
		seventh: 6,
		eighth: 7,
		one: 0,
		two: 1,
		three: 2,
		four: 3,
		five: 4,
		six: 5,
		seven: 6,
		eight: 7,
		nine: 8,
		ten: 9,
	};

	if (map[cleaned] != null) return map[cleaned];

	const token = cleaned.split(" ")[0];
	if (map[token] != null) return map[token];

	return null;
}

function isVisible(el) {
	if (!el) return false;
	const style = window.getComputedStyle?.(el);
	if (!style) return true;
	if (style.display === "none" || style.visibility === "hidden") return false;
	const rect = el.getBoundingClientRect?.();
	return !rect || (rect.width > 0 && rect.height > 0);
}

function normText(x) {
	return normalize(String(x || "").replace(/\s+/g, " ").trim());
}

function setElementValue(el, value) {
	if (!el) return false;
	const text = String(value ?? "");

	try {
		el.focus?.();

		if (el.isContentEditable) {
			el.textContent = text;
		} else {
			const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
			const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
			if (setter) setter.call(el, text);
			else el.value = text;
		}

		["input", "change", "blur"].forEach((type) => {
			el.dispatchEvent(new Event(type, { bubbles: true }));
		});
		return true;
	} catch (e) {
		console.warn("setElementValue failed:", e);
		return false;
	}
}

function findComposerRoot() {
	const roots = Array.from(document.querySelectorAll("[role='dialog'], form, .ReactModal__Content, .ui-dialog"))
		.filter(isVisible);

	for (const root of roots) {
		if (
			root.querySelector("input[name*='subject' i], input[placeholder*='subject' i], textarea, iframe.tox-edit-area__iframe, #message-body-root_ifr")
		) {
			return root;
		}
	}
	return document;
}

function collectTextButtons(root = document) {
	return Array.from(root.querySelectorAll("button, a, [role='button'], [role='menuitem'], [role='option']"))
		.filter(isVisible)
		.map((el) => ({ el, text: (el.textContent || el.getAttribute?.("aria-label") || "").trim() }))
		.filter((x) => x.text);
}

function findComposeButton() {
	const candidates = collectTextButtons(document);
	return (
		candidates.find((x) => /\b(compose|new message|create message)\b/i.test(x.text))?.el ||
		document.querySelector("[data-testid*='compose' i], [aria-label*='compose' i], [aria-label*='new message' i]")
	);
}

function findCourseSelect(root) {
	const selects = Array.from(root.querySelectorAll("select")).filter(isVisible);
	return (
		selects.find((el) => {
			const meta = `${el.name || ""} ${el.id || ""} ${el.getAttribute("aria-label") || ""}`;
			const optionText = Array.from(el.options || [])
				.map((o) => o.textContent || "")
				.join(" ");
			return /\b(course|context)\b/i.test(`${meta} ${optionText}`);
		}) || null
	);
}

function findCourseControl(root) {
	const native = findCourseSelect(root);
	if (native) return native;

	const controls = Array.from(root.querySelectorAll("[role='combobox'], button, [role='button'], input")).filter(isVisible);
	return (
		controls.find((el) => {
			const meta = `${el.getAttribute?.("name") || ""} ${el.getAttribute?.("id") || ""} ${
				el.getAttribute?.("placeholder") || ""
			} ${el.getAttribute?.("aria-label") || ""} ${el.textContent || ""}`.toLowerCase();
			return /\b(course|context|select course)\b/.test(meta);
		}) || null
	);
}

function getNativeSelectOptions(select) {
	return Array.from(select?.options || [])
		.map((opt) => ({
			label: (opt.textContent || "").trim(),
			value: opt.value,
		}))
		.filter((opt) => opt.label && !/^(select|choose)\b/i.test(opt.label));
}

function selectNativeOption(select, option) {
	if (!select || !option) return false;
	select.value = option.value;
	["input", "change", "blur"].forEach((type) => {
		select.dispatchEvent(new Event(type, { bubbles: true }));
	});
	return true;
}

function findSubjectInput(root) {
	return (
		root.querySelector("input[name*='subject' i], input[placeholder*='subject' i], input[aria-label*='subject' i]") || null
	);
}

function findRecipientInput(root) {
	const candidates = Array.from(
		root.querySelectorAll("input, textarea, [contenteditable='true'], [role='textbox'], [role='combobox']")
	).filter(isVisible);

	for (const el of candidates) {
		const meta = `${el.getAttribute?.("name") || ""} ${el.getAttribute?.("id") || ""} ${
			el.getAttribute?.("placeholder") || ""
		} ${el.getAttribute?.("aria-label") || ""}`.toLowerCase();
		if (/\b(to|recipient|recipients|user|users)\b/.test(meta) && !/\bsubject\b/.test(meta)) return el;
	}
	return null;
}

function findMessageEditor(root) {
	return (
		root.querySelector("textarea[name*='body' i], textarea[aria-label*='message' i], textarea[placeholder*='message' i]") ||
		root.querySelector("[contenteditable='true'][role='textbox'], [contenteditable='true'][aria-label*='message' i]") ||
		root.querySelector("iframe.tox-edit-area__iframe, #message-body-root_ifr")
	);
}

function setMessageBody(root, text) {
	const editor = findMessageEditor(root);
	if (!editor) return false;

	if (editor.tagName === "IFRAME") {
		try {
			const iframeDoc = editor.contentDocument || editor.contentWindow?.document;
			if (!iframeDoc) return false;
			let paragraph = iframeDoc.querySelector("p");
			if (!paragraph) {
				paragraph = iframeDoc.createElement("p");
				iframeDoc.body.innerHTML = "";
				iframeDoc.body.appendChild(paragraph);
			}
			paragraph.textContent = text;
			["input", "change", "keydown", "keyup", "blur"].forEach((type) => {
				paragraph.dispatchEvent(new Event(type, { bubbles: true }));
			});
			return true;
		} catch (e) {
			console.warn("setMessageBody iframe failed:", e);
			return false;
		}
	}

	return setElementValue(editor, text);
}

function visibleOptionElements() {
	const sels = [
		"[role='listbox'] [role='option']",
		"[role='dialog'] [role='option']",
		"[role='presentation'] [role='option']",
		"ul[role='listbox'] li",
		".Select-menu [role='option']",
		".Select-menu div",
	];
	return Array.from(document.querySelectorAll(sels.join(", ")))
		.filter(isVisible)
		.filter((el) => (el.textContent || "").trim().length > 0);
}

function getVisibleOptions() {
	return visibleOptionElements().map((el) => ({
		label: (el.textContent || "").trim(),
		el,
	}));
}

async function openCourseOptions(root) {
	const control = findCourseControl(root);
	if (!control) return [];

	const native = control.tagName === "SELECT" ? control : null;
	if (native) return getNativeSelectOptions(native);

	clickAndNavigate(control);
	await sleep(250);
	return getVisibleOptions();
}

function findBestOptionMatch(options, utterance) {
	const idx = ordinalToIdx(utterance);
	if (idx != null && options[idx]) return options[idx];

	const said = normText(utterance);
	if (!said) return null;

	let best = null;
	let bestScore = 0;
	for (const option of options) {
		const label = normText(option.label);
		if (!label) continue;
		let score = 0;
		if (said === label) score += 10;
		if (said.includes(label)) score += 8;
		if (label.includes(said)) score += 6;
		const saidWords = new Set(said.split(" ").filter(Boolean));
		const labelWords = label.split(" ").filter(Boolean);
		for (const word of labelWords) if (saidWords.has(word)) score += 1;
		if (score > bestScore) {
			best = option;
			bestScore = score;
		}
	}
	return bestScore >= 3 ? best : null;
}

async function ensureComposerOpen() {
	const existing = findComposerRoot();
	if (existing !== document) return { ok: true, root: existing };

	const btn = findComposeButton();
	if (!btn) return { ok: false, message: "Compose button not found" };

	clickAndNavigate(btn);
	const root = await waitFor(() => {
		const next = findComposerRoot();
		return next !== document ? next : null;
	}, { timeoutMs: 2500, stepMs: 100 });

	if (!root) return { ok: false, message: "Compose dialog did not open" };
	return { ok: true, root };
}

function clickButtonByText(root, re) {
	const btn = collectTextButtons(root).find((x) => re.test(x.text))?.el;
	if (!btn) return false;
	clickAndNavigate(btn);
	return true;
}

async function askForCourseSelection(root) {
	const select = findCourseSelect(root);
	const options = select ? getNativeSelectOptions(select) : [];
	await mem.set({ composeFlow: { stage: "course", options } });
	await speak("Select a course. Say the course name, or say list options if you want me to read the course choices.", {
		mode: "say",
	});
	return { ok: true, message: options.length ? "Asked for course with native options cached" : "Asked for course" };
}

async function handleComposeCourse(utterance) {
	const st = await mem.get();
	const flow = st.composeFlow || {};
	const draft = st.composeDraft || {};
	const root = findComposerRoot();
	const select = findCourseSelect(root);
	const said = normText(utterance);

	if (/\b(list|options|choices|what are the options|read the options)\b/i.test(said)) {
		const openedOptions = await openCourseOptions(root);
		const options = openedOptions.length ? openedOptions : flow.options || [];
		await mem.set({ composeFlow: { stage: "course", options } });
		if (!options.length) {
			await speak("I still can't read the course options. Open the course dropdown, then say list options again or just say the course name.", {
				mode: "say",
			});
			return { ok: false, message: "No course options available" };
		}

		let msg = "Course options. ";
		options.slice(0, 10).forEach((opt, i) => {
			msg += `${i + 1}: ${opt.label}. `;
		});
		msg += "Say the course name or the option number.";
		await speak(msg, { raw: true });
		return { ok: true, message: "Listed course options" };
	}

	const domOptions = getVisibleOptions();
	const nativeOptions = getNativeSelectOptions(select);
	const options = flow.options?.length ? flow.options : nativeOptions.length ? nativeOptions : domOptions;
	const choice = findBestOptionMatch(options, utterance);

	if (!choice) {
		await speak("I missed the course. Say the course name or option number.", { mode: "say" });
		return { ok: false, message: "Course not matched" };
	}

	if (choice.el) {
		clickAndNavigate(choice.el);
	} else if (select && !selectNativeOption(select, choice)) {
		await speak("I found the course, but I couldn't select it automatically.", { mode: "say" });
		return { ok: false, message: "Course select failed" };
	}

	await sleep(300);
	await mem.set({
		composeDraft: { ...draft, course: choice.label },
		composeFlow: { stage: "recipient" },
	});
	await speak(`Selected ${choice.label}. Who is the recipient? Say the person's name.`, { mode: "say" });
	return { ok: true, message: `Selected course: ${choice.label}` };
}

async function handleComposeRecipient(utterance) {
	const st = await mem.get();
	const draft = st.composeDraft || {};
	const root = findComposerRoot();
	const input = findRecipientInput(root);
	if (!input) {
		await speak("I can't find the recipient box. Select the recipient manually, then say the subject line.", { mode: "say" });
		await mem.set({ composeFlow: { stage: "subject" }, composeDraft: { ...draft, recipient: utterance } });
		return { ok: false, message: "Recipient input not found" };
	}

	setElementValue(input, utterance);
	await sleep(600);

	const visibleOptions = getVisibleOptions();
	const match = findBestOptionMatch(visibleOptions, utterance);

	if (match?.el) {
		clickAndNavigate(match.el);
	} else {
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
	}

	await sleep(300);
	await mem.set({
		composeDraft: { ...draft, recipient: utterance },
		composeFlow: { stage: "subject" },
	});
	await speak("What is the subject line?", { mode: "say" });
	return { ok: true, message: `Recipient set: ${utterance}` };
}

async function handleComposeSubject(utterance) {
	const st = await mem.get();
	const draft = st.composeDraft || {};
	const root = findComposerRoot();
	const input = findSubjectInput(root);
	if (!input || !setElementValue(input, utterance)) {
		await speak("I couldn't fill the subject line automatically. Enter it manually, then say the message.", { mode: "say" });
		await mem.set({ composeFlow: { stage: "body" }, composeDraft: { ...draft, subject: utterance } });
		return { ok: false, message: "Subject input failed" };
	}

	await mem.set({
		composeDraft: { ...draft, subject: utterance },
		composeFlow: { stage: "body" },
	});
	await speak("What is the message?", { mode: "say" });
	return { ok: true, message: "Subject set" };
}

async function speakDraftSummary(draft) {
	const parts = [
		draft.course ? `Course: ${draft.course}.` : "",
		draft.recipient ? `Recipient: ${draft.recipient}.` : "",
		draft.subject ? `Subject: ${draft.subject}.` : "",
		draft.body ? `Message: ${draft.body}.` : "",
	].filter(Boolean);
	await speak(parts.join(" "), { mode: "say" });
}

async function handleComposeBody(utterance) {
	const st = await mem.get();
	const draft = st.composeDraft || {};
	const root = findComposerRoot();
	const ok = setMessageBody(root, utterance);

	await mem.set({
		composeDraft: { ...draft, body: utterance },
		composeFlow: { stage: "confirm" },
	});

	if (!ok) {
		await speak("I couldn't fill the message box automatically. Add the message manually if needed.", { mode: "say" });
	}
	await speak("Do you want to send the message, cancel, or reread it?", { mode: "say" });
	return { ok, message: ok ? "Body set" : "Body input failed" };
}

async function finishCompose(cancel = false) {
	const root = findComposerRoot();
	const st = await mem.get();
	const draft = st.composeDraft || {};

	if (cancel) {
		clickButtonByText(root, /\b(cancel|close)\b/i);
		await mem.set({ composeFlow: null, composeDraft: null });
		await speak("Message canceled.", { mode: "say" });
		return { ok: true, message: "Compose canceled" };
	}

	const sent = clickButtonByText(root, /\b(send|send message)\b/i);
	await mem.set({ composeFlow: null, composeDraft: null });
	if (!sent) {
		await speak("I couldn't find the send button. Review the draft and send it manually.", { mode: "say" });
		return { ok: false, message: `Send button not found for ${draft.subject || "draft"}` };
	}

	await speak("Message sent.", { mode: "say" });
	return { ok: true, message: "Message sent" };
}

async function handleComposeFlow(utterance) {
	const st = await mem.get();
	const flow = st.composeFlow || {};
	const draft = st.composeDraft || {};
	const said = String(utterance || "").trim();
	const saidNorm = normText(said);

	if (!flow.stage) return null;

	if (/\b(cancel|never mind|nevermind|stop)\b/i.test(said)) {
		return await finishCompose(true);
	}

	switch (flow.stage) {
		case "course":
			return await handleComposeCourse(said);
		case "recipient":
			return await handleComposeRecipient(said);
		case "subject":
			return await handleComposeSubject(said);
		case "body":
			return await handleComposeBody(said);
		case "confirm":
			if (/\b(reread|read it|read message|repeat)\b/i.test(saidNorm)) {
				await speakDraftSummary(draft);
				await speak("Say send, cancel, or reread.", { mode: "say" });
				return { ok: true, message: "Reread draft" };
			}
			if (/\b(send|send it|yes send)\b/i.test(saidNorm)) {
				return await finishCompose(false);
			}
			await speak("Say send, cancel, or reread.", { mode: "say" });
			return { ok: false, message: "Waiting for compose confirmation" };
		default:
			return null;
	}
}

async function actChooseOption(idxRaw) {
	const st = await mem.get();
	const opts = st.choiceOptions || [];
	const i = ordinalToIdx(idxRaw);

	if (i == null || !opts[i]) {
		await speak("Say option 1, option 2, and so on.", { mode: "say" });
		return { ok: false, message: "Invalid choice" };
	}

	await mem.set({ expectingChoice: false, choiceOptions: null });

	const chosen = opts[i];
	await speak(`Opening: ${chosen.label}.`, { mode: "say" });
	if (chosen.href) window.location.href = chosen.href;

	return { ok: true, message: `Chose: ${chosen.label}` };
}

// =============================================================================
// 11) Course lookup improvements (exact + partial + name + list-all fallback)
// =============================================================================

function isCourseHomeLink(el) {
	const href = (el.getAttribute?.("href") || el.href || "").toLowerCase();
	if (!href.includes("/courses/")) return false;

	const m = href.match(/\/courses\/(\d+)(\/)?($|[?#])/i);
	if (!m) return false;

	const after = href.replace(/.*\/courses\/\d+/i, "");
	if (after && after !== "/" && !after.startsWith("?") && !after.startsWith("#")) return false;

	return true;
}

function allCourseCandidates() {
	const els = Array.from(
		document.querySelectorAll("a[href*='/courses/'], .ic-DashboardCard__link, [role='link']")
	).filter(Boolean);

	const home = els.filter(isCourseHomeLink);
	return home.length ? home : els;
}

function normalizeCourseLabel(label) {
	return String(label || "")
		.replace(/\s+/g, " ")
		.replace(/[()]/g, " ")
		.trim();
}

function parseCourseQueryFromUtterance(cleaned) {
	const s = String(cleaned || "").toLowerCase().trim();
	if (!s.startsWith("open ")) return null;

		  const remainder = s.replace(/^open\s+/, "").trim();
	if (/\bcourse\b/.test(remainder)) {
		const numMatch = remainder.match(/\b(\d{1,4})\b/);
		const num = numMatch ? numMatch[1] : null;
		const deptMatch = remainder.match(/\b(csce|cse|csc|cs)\b/);
		const dept = deptMatch ? deptMatch[1] : null;
		return { dept, num, remainder };
	}

	const deptMatch = remainder.match(/\b(csce|cse|csc|cs)\b/);
	const dept = deptMatch ? deptMatch[1] : null;
	if (dept) {
		const numMatch = remainder.match(/\b(\d{1,4})\b/);
		const num = numMatch ? numMatch[1] : null;
		return { dept, num, remainder };
	}

	const numMatch = remainder.match(/\b(\d{4})\b/);
	const num = numMatch ? numMatch[1] : null;
	if (num) return { dept: null, num, remainder };

	return null;
}
function scoreCourseCandidate(label, href, q) {
	const L = normalizeCourseLabel(label).toLowerCase();
	const H = String(href || "").toLowerCase();

	let score = 0;

	if (q.dept) {
		if (L.includes(q.dept)) score += 2.0;
		if (q.dept === "cse" && L.includes("csce")) score += 1.2;
		if (q.dept === "cs" && (L.includes("csce") || L.includes("cse"))) score += 1.0;
	}

	if (q.num) {
		const exact4 = q.num.length === 4 && new RegExp(`\\b${q.num}\\b`).test(L);
		if (exact4) score += 5.0;
		if (!exact4 && L.includes(q.num)) score += 2.0;
		if (H.includes(q.num)) score += 0.8;
	}
	const tokens = q.remainder
		.replace(/\b(open|course|csce|cse|cs)\b/g, "")
		.replace(/[^\w\s]/g, " ")
		.split(/\s+/)
		.filter((t) => t.length >= 3);

	for (const t of tokens) {
		if (L.includes(t)) score += 0.7;
	}

	if (isCourseHomeLink({ getAttribute: () => href, href })) score += 0.8;

	return score;
}

function collectAllCourseOptions() {
	const els = allCourseCandidates();

	const seen = new Set();
	const options = [];

	for (const el of els) {
		const href = el.href || el.getAttribute?.("href") || "";
		if (!href) continue;
		if (!isCourseHomeLink(el)) continue;

		const key = href.replace(/[?#].*$/, "");
		if (seen.has(key)) continue;
		seen.add(key);

		const labelRaw = el.textContent || el.getAttribute?.("aria-label") || "Course";
		const label = normalizeCourseLabel(labelRaw);

		options.push({ el, href: key, label });
	}
	return options;
}

async function actListCoursesFallback(prompt = "Here are your courses.") {
	const all = collectAllCourseOptions();

	if (!all.length) {
		await speak("I can't find your course list on this page. Want me to open Courses?", { mode: "say" });
		await mem.set({ expectingYesNo: true, pendingAction: "OPEN_COURSES" });
		return { ok: false, message: "No courses found to list" };
	}

	const opts = all.slice(0, 8).map((o) => ({ label: o.label, href: o.href }));
	await askChoice(opts, prompt);
	return { ok: true, message: "Listed courses for user to choose" };
}

async function actConfirmOrChooseCourse(best, candidates, queryText) {
	await mem.set({
		expectingYesNo: true,
		pendingAction: "OPEN_COURSE_CONFIRM",
		pendingHref: best.href,
		pendingLabel: best.label,
		expectingChoice: false,
		choiceOptions: null,
	});

	const msg =
		`"${queryText}" doesn’t match exactly. Did you mean ${best.label}? ` +
		`Say yes to open it, or say no to hear similar courses.`;
	await speak(msg, { mode: "say" });
	return { ok: true, message: "Asked for confirmation (course)" };
}

async function actOpenCourseByQuery(cleanedUtterance) {
	const q = parseCourseQueryFromUtterance(cleanedUtterance);
	if (!q) return { ok: false, message: "Not a course query" };

	const all = collectAllCourseOptions();

	if ((!q.num || q.num.length < 4) && (!q.remainder || q.remainder.length <= 6)) {
		let filtered = all;
		if (q.dept) {
			filtered = all.filter((o) => normalizeCourseLabel(o.label).toLowerCase().includes(q.dept));
			if (!filtered.length && q.dept === "cse") {
				filtered = all.filter((o) => normalizeCourseLabel(o.label).toLowerCase().includes("csce"));
			}
		}

		if (filtered.length) {
			const prompt = "That’s not a full course name. Here are the closest matches.";
			await askChoice(filtered.slice(0, 8).map((o) => ({ label: o.label, href: o.href })), prompt);
			return { ok: true, message: "Asked user to choose course (vague query)" };
		}

		return await actListCoursesFallback("I didn’t catch the exact course. Here are all your courses.");
	}

	const scored = all
		.map((o) => ({
			...o,
			score: scoreCourseCandidate(o.label, o.href, q),
		}))
		.sort((a, b) => b.score - a.score);

	const best = scored[0];
	const strong = best && best.score >= 5.0;
	if (!best || best.score < 2.2) {
		const prompt = `I couldn’t find a course matching "${q.remainder}". Here are all your courses.`;
		return await actListCoursesFallback(prompt);
	}

	const codeMatch =
		(best.label || "").match(/\b\d{4}\b/) ||
		(best.href || "").match(/\b\d{4}\b/);

		const deptMatch = (best.label || "").toLowerCase().match(/\b(csce|cse|csc|cs|psci|math|engl|hist|biol|chem|phys)\b/);

		const courseNum = (best.label.match(/\b\d{4}\b/) || [null])[0];

		await remember({
		lastIntent: intents.OPEN_COURSE_BY_NUMBER,
		lastLinkText: best.label,
		lastLinkHref: best.href,
		activeCourseHref: best.href,

		// ✅ NEW: course number barrier data (dynamic for anyone)
		activeCourseNum: courseNum || null,
		});

	if (q.num && q.num.length < 4) {
		const similar = scored.filter((x) => x.score >= best.score - 2.0).slice(0, 8);
		const prompt = `That looks incomplete ("${q.num}"). Which one do you mean?`;
		await askChoice(similar.map((o) => ({ label: o.label, href: o.href })), prompt);
		return { ok: true, message: "Asked choice (partial course number)" };
	}


	if (!strong) {
		const similar = scored.filter((x) => x.score >= best.score - 1.3).slice(0, 8);
		return await actConfirmOrChooseCourse(best, similar, q.remainder);
	}

	const short = speakCourseShort(best.label, best.href);
	const inferredNum =
	(best.label.match(/\b\d{3,4}\b/) || [null])[0] ||
	(best.href.match(/\b\d{3,4}\b/) || [null])[0] ||
	null;

	await speak(`Opening ${short}.`, { mode: "say" });

	// ✅ Remember FIRST so chained plans can reliably resume in the right course
	await remember({
	lastIntent: intents.OPEN_COURSE_BY_NUMBER,
	lastLinkText: best.label,
	lastLinkHref: best.href,
	activeCourseHref: best.href,
	activeCourseNum: inferredNum,   // ✅ NEW
	});

	const targetHref = best.href;

	hardCancelResumes();
	await suppressAutoResume(5000);

	await navigateTopLevel(targetHref);
	await chrome.runtime.sendMessage({ action: "CONVOX_NAVIGATE", url: best.href });

	return { ok: true, message: `Opened course: ${best.label}` };


	}

async function actOpenCourseByNumber(courseNumRaw) {
	const n = String(courseNumRaw || "").trim();
	if (!n) {
		await speak("Which course number?", { mode: "say" });
		return { ok: false, message: "Missing course number" };
	}
	return await actOpenCourseByQuery(`open ${n}`);
}

// =============================================================================
	  // =============================================================================
	  // 12) Queue (multi-step commands across navigation)
	  //    IMPORTANT CHANGE: no persistent "pendingQueueRunning" boolean in Memory
	  // =============================================================================

	  async function setQueue(steps = [], meta = {}) {
		  const payload = Array.isArray(steps) ? steps : [];
		  const meta2 = { createdAt: Date.now(), ...meta };

		  // Persist to Memory
		  await mem.set({
			  pendingQueue: payload,
			  pendingQueueMeta: meta2,
		  });

		  // Backup persist to sessionStorage (survives nav even if storage races)
		  __CONVOX.actions.saveResumeQueue(payload, meta2);

		  // Tiny yield helps Chrome flush storage before navigation
		  await delay(50);
	  }

	  async function clearQueue() {
		  await mem.set({ pendingQueue: null, pendingQueueMeta: null });
		  __CONVOX.actions.clearResumeQueue();
	  }

	  async function shiftQueue() {
		  const st = await mem.get();
		  const q = Array.isArray(st.pendingQueue) ? [...st.pendingQueue] : [];

		  q.shift();

		  await mem.set({ pendingQueue: q.length ? q : null });

		  // Keep sessionStorage mirror in sync
		  if (q.length) {
			  __CONVOX.actions.saveResumeQueue(q, st.pendingQueueMeta || {});
		  } else {
			  __CONVOX.actions.clearResumeQueue();
			  await mem.set({ pendingQueueMeta: null });
		  }

		  return q;
	  }

	  function parseCourseNumberFromText(t = "") {
		  const s = String(t).toLowerCase();
	const m = s.match(/\b(?:csce|cse|csc|cs)\s*(\d{4})\b/i) || s.match(/\b(\d{4})\b/);
	return m ? m[1] : null;
}

function parseMonthDay(text = "") {

	const t = String(text).toLowerCase();

	const mmdd = t.match(/\b(0?[1-9]|1[0-2])\s*\/\s*(0?[1-9]|[12]\d|3[01])\b/);
	if (mmdd) return { month: parseInt(mmdd[1], 10), day: parseInt(mmdd[2], 10) };

	const months = {
		jan: 1,
		january: 1,
		feb: 2,
		february: 2,
		mar: 3,
		march: 3,
		apr: 4,
		april: 4,
		may: 5,
		jun: 6,
		june: 6,
		jul: 7,
		july: 7,
		aug: 8,
		august: 8,
		sep: 9,
		sept: 9,
		september: 9,
		oct: 10,
		october: 10,
		nov: 11,
		november: 11,
		dec: 12,
		december: 12,
	};

	const m = t.match(
		/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t)?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b[^0-9]{0,6}\b(0?[1-9]|[12]\d|3[01])\b/
	);
	if (m) return { month: months[m[1]], day: parseInt(m[2], 10) };

	return null;
}

function monthDayMatches(text = "", md) {
	if (!md) return false;
	const lower = String(text).toLowerCase();

	const monthNames = [
		null,
		["jan", "january"],
		["feb", "february"],
		["mar", "march"],
		["apr", "april"],
		["may"],
		["jun", "june"],
		["jul", "july"],
		["aug", "august"],
		["sep", "sept", "september"],
		["oct", "october"],
		["nov", "november"],
		["dec", "december"],
	];


	const numeric = new RegExp(`\\b0?${md.month}\\s*\\/\\s*0?${md.day}\\b`, "i");
	if (numeric.test(lower)) return true;

	const names = monthNames[md.month] || [];
	for (const n of names) {
		const re = new RegExp(`\\b${n}\\b[^0-9]{0,6}\\b0?${md.day}\\b`, "i");
		if (re.test(lower)) return true;
	}
	return false;
}

async function waitFor(fn, { timeoutMs = 2500, stepMs = 150 } = {}) {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const v = fn();
		if (v) return v;
		await new Promise((r) => setTimeout(r, stepMs));
	}
	return null;
}


function sleep(ms) {
	return new Promise((res) => setTimeout(res, ms));
}

function setNativeValue(el, value) {
	const proto = Object.getPrototypeOf(el);
	const desc = Object.getOwnPropertyDescriptor(proto, "value");
	if (desc && desc.set) desc.set.call(el, value);
	else el.value = value;
}

function findAssignmentsSearchBox() {
	const candidates = Array.from(
		document.querySelectorAll("input[type='text'], input[role='searchbox'], input")
	).filter(Boolean);

	for (const el of candidates) {
		const ph = (el.getAttribute("placeholder") || "").toLowerCase();
		const aria = (el.getAttribute("aria-label") || "").toLowerCase();
		const id = (el.id || "").toLowerCase();

		if (ph.includes("search") && ph.includes("assignment")) return el;
		if (aria.includes("search") && aria.includes("assignment")) return el;
		if (id.includes("search") && id.includes("assign")) return el;
	}
	return null;
}

function collectAssignmentLinks() {
	const selectors = [
		"a[href*='/assignments/']",
		"a.ig-title",
		".assignment a[href]",
		"[data-testid*='assignment'] a[href]",
		"[role='link'][href*='/assignments/']",
	];

	const anchors = Array.from(document.querySelectorAll(selectors.join(", "))).filter(
		(a) => a && (a.href || a.getAttribute("href"))
	);

	const seen = new Set();
	const out = [];
	for (const a of anchors) {
		const href = a.href || a.getAttribute("href") || "";
		if (!href) continue;
		if (seen.has(href)) continue;
		seen.add(href);
		out.push(a);
	}
	return out;
}

function buildAssignmentVariants(qText) {
	const q = normalize(qText);
	const m = q.match(/\b(\d+)\b/);
	const n = m ? m[1] : null;

	const variants = new Set();
	if (!n) {
		variants.add(q);
		variants.add(q.replace(/\s+/g, ""));
		return variants;
	}

	variants.add(`hw ${n}`);
	variants.add(`hw${n}`);
	variants.add(`homework ${n}`);
	variants.add(`homework${n}`);
	variants.add(`assignment ${n}`);
	variants.add(`assignment${n}`);
	variants.add(`h w ${n}`);
	variants.add(`h.w ${n}`);
	variants.add(`h.w. ${n}`);

	return variants;
}

async function actOpenAssignmentQuery(qRaw) {
	const qText = String(qRaw || "").trim();
	if (!qText) {
		await speak("Which assignment? Like: HW 2.", { mode: "say" });
		return { ok: false, message: "Missing assignment query" };
	}

	if (!location.pathname.includes("/assignments")) {
		await speak("Opening assignments.", { mode: "say" });
		await actOpenAssignments();
		await speak(`When it loads, say: open ${qText}.`, { mode: "say" });
		return { ok: true, message: "Opened assignments then asked to retry" };
	}

	const variants = buildAssignmentVariants(qText);

	const searchBox = findAssignmentsSearchBox();
	if (searchBox) {
		const num = (qText.match(/\d+/) || [null])[0];
		const typed = num ? `hw${num}` : qText;

		setNativeValue(searchBox, typed);
		searchBox.dispatchEvent(new Event("input", { bubbles: true }));
		searchBox.dispatchEvent(new Event("change", { bubbles: true }));

		await speak(`Searching for ${qText}.`, { mode: "say" });
		await sleep(350);
	}

	const links = collectAssignmentLinks();

	const scored = links
		.map((a) => {
			const text = normalize(a.textContent || a.getAttribute("aria-label") || "");
			const href = a.href || a.getAttribute("href") || "";
			let score = 0;

			for (const v of variants) {
				if (!v) continue;
				if (text.includes(v)) score += 3;
				const dm = v.match(/\b(\d+)\b/);
				if (dm && text.includes(dm[1])) score += 0.6;
			}

			if (href.includes("/assignments/")) score += 0.4;

			const r = a.getBoundingClientRect?.();
			if (r && r.width > 20 && r.height > 12) score += 0.2;

			return { a, href, label: (a.textContent || "Assignment").trim().replace(/\s+/g, " "), score };
		})
		.filter((x) => x.href && x.score >= 2.7)
		.sort((x, y) => y.score - x.score);

	if (scored.length === 0) {
		if (searchBox) {
			setNativeValue(searchBox, "");
			searchBox.dispatchEvent(new Event("input", { bubbles: true }));
		}

		await speak(`I can't find ${qText}. Say "read the page" for a quick list.`, { mode: "say" });
		return { ok: false, message: "Assignment not found" };
	}

	if (scored.length >= 2 && scored[1].score >= scored[0].score - 0.6) {
		await askChoice(
			scored.slice(0, 8).map((m) => ({ label: m.label, href: m.href })),
			`I found a few matches for ${qText}. Which one?`
		);
		return { ok: true, message: "Asked choice for assignment" };
	}

	await speak(`Opening ${scored[0].label}.`, { mode: "say" });
	window.location.href = scored[0].href;
	return { ok: true, message: `Opened assignment: ${scored[0].label}` };
}

async function actReadAssignmentsSummary() {
	const items = Array.from(
		document.querySelectorAll("a[href*='/assignments/'], .assignment a, .ig-title a, [data-testid*='assignment'] a")
	)
		.map((a) => (a.textContent || "").trim().replace(/\s+/g, " "))
		.filter(Boolean);

	if (items.length === 0) {
		await speak("I can't find assignment titles here. Want me to read the page?", { mode: "say" });
		await mem.set({ expectingYesNo: true, pendingAction: "READ_PAGE" });
		return { ok: false, message: "No assignment titles found" };
	}

	const top = items.slice(0, 6);
	await speak(`Here are a few: ${top.join(", ")}.`, { mode: "say", maxChars: 260 });
	await speak("Say: open homework 2. Or: option 1.", { mode: "say" });
	return { ok: true, message: "Read assignments summary" };
}

// =============================================================================
// 14) Compound actions (course + assignments + due date)
// =============================================================================

const INTERNAL_INTENTS = {
	OPEN_ASSIGNMENT_DUE_IN: "OPEN_ASSIGNMENT_DUE_IN",
};

async function findAssignmentByDueMonthDay(md) {
	const candidates = collectAssignmentLinks().map((a) => {
		const container = a.closest("li, tr, div, article, section") || a.parentElement;
		const blob = (container?.textContent || a.textContent || "").replace(/\s+/g, " ").trim();
		return { a, href: a.href || a.getAttribute("href") || "", label: (a.textContent || "").trim(), blob };
	});

	const matches = candidates.filter((c) => c.href && monthDayMatches(c.blob, md));
	return matches;
}

async function actOpenAssignmentDueIn(mdRaw) {
	const md = typeof mdRaw === "string" ? parseMonthDay(mdRaw) : mdRaw;
	if (!md) {
		await speak("Tell me the due date like: Feb 21.", { mode: "say" });
		return { ok: false, message: "Missing/invalid due date" };
	}

	if (!location.pathname.includes("/assignments")) {
		const st = await mem.get();
		const existing = Array.isArray(st.pendingQueue) ? st.pendingQueue : [];
		await setQueue([...existing, { intent: INTERNAL_INTENTS.OPEN_ASSIGNMENT_DUE_IN, slots: { md } }], {
			kind: "OPEN_ASSIGNMENT_DUE_IN",
		});

		await speak("Opening assignments first.", { mode: "say" });
		return await actOpenAssignments();
	}

	await waitFor(() => collectAssignmentLinks().length > 0, { timeoutMs: 3500 });

	const matches = await findAssignmentByDueMonthDay(md);

	if (!matches.length) {
		await speak("I couldn’t find an assignment with that due date here. Say: read the page.", { mode: "say" });
		return { ok: false, message: "No due-date matches" };
	}

	if (matches.length > 1) {
		await askChoice(
			matches.slice(0, 8).map((m) => ({ label: m.label || "Assignment", href: m.href })),
			"I found a few assignments due that day. Which one?"
		);
		return { ok: true, message: "Asked choice (due-date matches)" };
	}

	await speak(`Opening ${matches[0].label || "the assignment"}.`, { mode: "say" });
	window.location.href = matches[0].href;
	return { ok: true, message: "Opened assignment by due date" };
}

async function actOpenAssignmentsForCourse(courseNumRaw) {
	const courseNum = String(courseNumRaw || "").trim();
	if (!courseNum) {
		await speak("Which course number?", { mode: "say" });
		return { ok: false, message: "Missing course number" };
	}

	await setQueue([{ intent: intents.OPEN_ASSIGNMENTS, slots: {} }], {
		kind: "OPEN_ASSIGNMENTS_FOR_COURSE",
		courseNum,
	});

	await speak(`Opening course ${courseNum}, then assignments.`, { mode: "say" });
	return await actOpenCourseByNumber(courseNum);
}

function parseCompoundAssignmentsForCourse(cleaned) {
	const u = String(cleaned || "").toLowerCase();
	const hasOpen = /\bopen\b/.test(u);
	const hasAssignments = /\bassignments?\b/.test(u) || /\bhomework\b/.test(u);
	const hasForCourse = /\b(for|in)\b/.test(u) && /\bcourse\b/.test(u);
	if (!(hasOpen && hasAssignments && (hasForCourse || /\bcsce|cse|cs|csc\b/.test(u)))) return null;

	const courseNum = parseCourseNumberFromText(u);
	if (!courseNum) return null;

	return { courseNum };
}

function parseCompoundAssignmentDueInCourse(cleaned) {
	const u = String(cleaned || "").toLowerCase();

	const hasOpen = /\bopen\b/.test(u);
	const hasAssignment = /\bassignment\b/.test(u) || /\bhomework\b/.test(u);
	const hasDue = /\bdue\b/.test(u);
	const courseNum = parseCourseNumberFromText(u);
	if (!(hasOpen && hasAssignment && hasDue && courseNum)) return null;

	const dueTail = (u.split(/\bdue\b/i)[1] || "").trim();
	const md = parseMonthDay(dueTail) || parseMonthDay(u);

	if (!md) return { courseNum, dueText: dueTail || u, md: null };
	return { courseNum, md, dueText: dueTail };
}

async function actOpenAssignmentDueInCourse({ courseNum, md, dueText }) {
	if (!courseNum) {
		await speak("Which course number?", { mode: "say" });
		return { ok: false, message: "Missing course number (compound due-in-course)" };
	}

	if (!md) {
		await speak("Tell me the due date like: Feb 21.", { mode: "say" });
		return { ok: false, message: "Missing/invalid due date (compound due-in-course)" };
	}

	await setQueue(
		[
			{ intent: intents.OPEN_ASSIGNMENTS, slots: {} },
			{ intent: INTERNAL_INTENTS.OPEN_ASSIGNMENT_DUE_IN, slots: { md } },
		],
		{ kind: "DUE_IN_COURSE", courseNum, md, dueText }
	);

	await speak(`Opening course ${courseNum}, then assignments due ${dueText || "that day"}.`, { mode: "say" });
	return await actOpenCourseByNumber(courseNum);
}

// =============================================================================
	  // 15) Navigation primitives
	  // =============================================================================

	  async function actGoBack() {
		  try {
			  // Cancel everything
			  await clearPlan();
			  await clearQueue();
			  await clearStickyModes();

			  // ✅ IMPORTANT: kill saved resume payloads so nothing “finishes” after back
			  hardCancelResumes();

			  // Suppress auto-resume for a moment
			  await suppressAutoResume(3000);

			  window.history.back();
			  await speak("Going back.", { mode: "say" });
			  return { ok: true, message: "Went back" };
		  } catch (e) {
			  await speak("I can't go back. Want me to open dashboard?", { mode: "say" });
			  await mem.set({ expectingYesNo: true, pendingAction: "OPEN_DASHBOARD" });
			  return { ok: false, message: "Back failed" };
		  }
	  }


	  async function actOpenDashboard() {
		  const candidates = [
			  { keywords: ["dashboard", "home"], hrefHints: ["/dashboard"], minScore: 2.0 },
			  { keywords: ["home"], hrefHints: ["/dashboard"], minScore: 2.0 },
			  { keywords: ["dashboard"], hrefHints: ["/dashboard"], minScore: 2.0 },
			  { keywords: ["courses", "course"], hrefHints: ["/courses"], minScore: 2.2 },
		  ];

		  let hit = null;
		  for (const c of candidates) {
			  hit = findBestLink(c);
			  if (hit?.el) break;
		  }

		  if (hit?.el) {
			  const link = hit.el;
		const label = (link.textContent || "Dashboard").trim();
		clickAndNavigate(link);
		await speak(`Opening ${label}.`, { mode: "say" });
		await clearStickyModes();
		return { ok: true, message: `Opened: ${label}` };
	}

	try {
		window.location.href = `${location.origin}/dashboard`;
		await speak("Opening dashboard.", { mode: "say" });
		await clearStickyModes();
		return { ok: true, message: "Navigated to /dashboard" };
	} catch {
		await speak("I can't find dashboard here. Want me to read the page?", { mode: "say" });
		await remember({ expectingYesNo: true, pendingAction: "READ_PAGE" });
		return { ok: false, message: "Dashboard not found" };
	}
}

// =============================================================================
// 16) Small talk
// =============================================================================

async function actSmallTalk(utterance) {
	const state = await mem.get();

	const u = normalize(utterance);
	if (/\b(thanks|thank you|appreciate)\b/.test(u)) {
		await speak("You got it.", { mode: "say" });
		return { ok: true, message: "Small talk: thanks" };
	}

	// No LLM. Keep it short and actionable.
	await speak("Hey. Want due today, due this week, summarize page, or open a course?", { mode: "say" });
	return { ok: true, message: "Small talk: fallback" };
}

// =============================================================================
// 17) Canvas page actions
// =============================================================================
async function actOpenGrades() {
	const state = await mem.get();
	const courseId = getActiveCourseId(state);

	// Prefer course-scoped grades
	if (courseId) {
		const scoped = findCourseScopedNavLink(courseId, "grades", ["grades", "grade"]);
		if (scoped) {
			clickAndNavigate(scoped);
			await speakNav("Opening grades.", { mode: "say", always: true });
			await remember({ lastIntent: intents.OPEN_GRADES, lastLinkText: "Grades", lastLinkHref: scoped.href });
			return { ok: true, message: "Opened: Grades (course-scoped)" };
		}
	}

	const link = findBestLink({
		keywords: ["grades", "grade", "marks", "score", "results"],
		hrefHints: ["/grades"],
	});
	if (link) {
		clickAndNavigate(link);
		await speakNav("Opening grades.", { mode: "say", always: true });
		await remember({ lastIntent: intents.OPEN_GRADES, lastLinkText: "Grades", lastLinkHref: link.href });
		return { ok: true, message: "Opened: Grades" };
	}

	await speakNav("I can't find Grades here. Want dashboard?", { mode: "say", always: true });
	await remember({ expectingYesNo: true, pendingAction: "OPEN_DASHBOARD" });
	return { ok: false, message: "Grades link not found" };
}

async function actOpenAssignments() {
	const state = await mem.get();
	const courseId = getActiveCourseId(state);

	// Prefer course-scoped assignments
	if (courseId) {
		const scoped = findCourseScopedNavLink(courseId, "assignments", [
			"assignments",
			"assignment",
			"homework",
			"tasks",
		]);

		if (scoped) {
			clickAndNavigate(scoped);
			await speakNav("Opening assignments.", { mode: "say", always: true });
			await remember({ lastIntent: intents.OPEN_ASSIGNMENTS, lastLinkText: "Assignments", lastLinkHref: scoped.href });
			return { ok: true, message: "Opened: Assignments (course-scoped)" };
		}
	}

	// Fallback: global
	const link = findBestLink({
		keywords: ["assignments", "assignment", "tasks", "homework", "to do", "to-do"],
		hrefHints: ["/assignments"],
	});
	if (link) {
		clickAndNavigate(link);
		await speakNav("Opening assignments.", { mode: "say", always: true });
		await remember({ lastIntent: intents.OPEN_ASSIGNMENTS, lastLinkText: "Assignments", lastLinkHref: link.href });
		return { ok: true, message: "Opened: Assignments" };
	}

	await speakNav("I can't find Assignments here. Want dashboard?", { mode: "say", always: true });
	await remember({ expectingYesNo: true, pendingAction: "OPEN_DASHBOARD" });
	return { ok: false, message: "Assignments link not found" };
}

	  async function actOpenModules() {
		  const state = await mem.get();
		  const courseId = getActiveCourseId(state);

		  // Prefer course-scoped modules
		  if (courseId) {
			  const scoped = findCourseScopedNavLink(courseId, "modules", ["modules", "module"]);
			  if (scoped) {
				  clickAndNavigate(scoped);
				  await speakNav("Opening modules.", { mode: "say", always: true });
				  await remember({ lastIntent: intents.OPEN_MODULES, lastLinkText: "Modules", lastLinkHref: scoped.href });
				  return { ok: true, message: "Opened: Modules (course-scoped)" };
			  }
		  }

		  // Fallback
		  const link = findBestLink({ keywords: ["modules", "module"], hrefHints: ["/modules"] });
		  if (link) {
			  clickAndNavigate(link);
			  await speakNav("Opening modules.", { mode: "say" });
			  await remember({ lastIntent: intents.OPEN_MODULES, lastLinkText: "Modules", lastLinkHref: link.href });
			  return { ok: true, message: "Opened: Modules" };
		  }

		  await speakNav("I can't find Modules here. Want dashboard?", { mode: "say", always: true });
		  await remember({ expectingYesNo: true, pendingAction: "OPEN_DASHBOARD" });
		  return { ok: false, message: "Modules link not found" };
	  }

	  async function actOpenInbox() {
		  const hit = findBestLink({
			  keywords: ["inbox", "conversations"],
			  hrefHints: ["/conversations"],
			  minScore: 2.2,
		  });

		  if (hit?.el) {
			  const el = hit.el;
			  clickAndNavigate(el);
			  await speakNav("Opening inbox.", { mode: "say", always: true });
			  await remember({
				  lastIntent: "OPEN_INBOX",
				  lastLinkText: (el.textContent || "Inbox").trim(),
				  lastLinkHref: el.href || el.getAttribute?.("href") || "",
			  });
			  return { ok: true, message: "Opened: Inbox" };
		  }

		  try {
			  window.location.href = `${location.origin}/conversations`;
		  } catch { }
		  await speakNav("Opening inbox.", { mode: "say", always: true });
		  return { ok: true, message: "Navigated to /conversations" };
	  }

	  async function actOpenFiles() {
		  const state = await mem.get();
		  const courseId = getActiveCourseId(state);

		  if (courseId) {
			  const scoped = findCourseScopedNavLink(courseId, "files", ["files", "file"]);
			  if (scoped) {
				  clickAndNavigate(scoped);
				  await speak("Opening files.", { mode: "say" });
				  await remember({ lastIntent: intents.OPEN_FILES, lastLinkText: "Files", lastLinkHref: scoped.href });
				  return { ok: true, message: "Opened: Files (course-scoped)" };
			  }
		  }

		  const link = findBestLink({ keywords: ["files", "file"], hrefHints: ["/files"] });
		  if (link) {
			  clickAndNavigate(link);
			  await speak("Opening files.", { mode: "say" });
			  return { ok: true, message: "Opened: Files" };
		  }

		  await speak("I can't find Files here. Want dashboard?", { mode: "say" });
		  return { ok: false, message: "Files link not found" };
	  }
async function actOpenCourses() {
	const link = findBestLink({
		keywords: ["courses", "course", "classes", "all courses"],
		hrefHints: ["/courses"],
	});
	if (link) {
		const label = (link.textContent || "Courses").trim();
		clickAndNavigate(link);
		await speak("Opening courses.", { mode: "say" });
		await remember({ lastIntent: intents.OPEN_COURSES, lastLinkText: label, lastLinkHref: link.href });
		return { ok: true, message: `Opened: ${label}` };
	}
	await speak("I can't find Courses here. Want dashboard?", { mode: "say" });
	await remember({ expectingYesNo: true, pendingAction: "OPEN_DASHBOARD" });
	return { ok: false, message: "Courses link not found" };
}

async function actNavigateTo(targetRaw) {
	const raw = String(targetRaw || "").trim();
	const target = normalize(raw);
	const words = target.split(" ").filter(Boolean);

	// 1) Fast-path known Canvas targets
	const KNOWN = [
		{ re: /\b(dashboard|home)\b/, fn: () => actOpenDashboard() },
		{ re: /\b(courses?|course list|all courses)\b/, fn: () => actOpenCourses() },
		{ re: /\b(assignments?|homework|tasks?|to do|to-do)\b/, fn: () => actOpenAssignments() },
		{ re: /\b(grades?|gradebook|marks|scores?)\b/, fn: () => actOpenGrades() },
		{ re: /\b(modules?)\b/, fn: () => actOpenModules() },
		{ re: /\b(quizzes?)\b/, fn: () => actOpenQuizzes() },
		{ re: /\b(files?)\b/, fn: () => actOpenFiles() },
		{ re: /\b(inbox|conversations?)\b/, fn: () => actOpenInbox() },

	];

	for (const k of KNOWN) {
		if (k.re.test(target)) return await k.fn();
	}

	// 2) Generic link scoring, but stricter
	const hit = findBestLink({
		keywords: words,
		hrefHints: ["/grades", "/assignments", "/courses", "/modules", "/quizzes", "/files", "/calendar", "/dashboard"],
		minScore: 3.2,
	});

	if (hit?.el) {
		const link = hit.el;
		const label = (link.textContent || raw).trim();
		clickAndNavigate(link);
		await speak(`Opening ${label}.`, { mode: "say" });
		await remember({ lastIntent: intents.NAVIGATE_TO, lastLinkText: label, lastLinkHref: link.href });
		return { ok: true, message: `Opened: ${label} (score=${hit.score})` };
	}

	await speak(
		`I didn’t recognize "${raw}". Try: dashboard, courses, assignments, grades, modules, quizzes, files, or back.`,
		{ mode: "say" }
	);

	await remember({
		expectingYesNo: false,
		pendingAction: null,
		expectingChoice: false,
		choiceOptions: null,
		lastIntent: intents.UNKNOWN,
	});

	return { ok: false, message: `Target not recognized or low confidence: ${raw}` };
}

function textFromNode(el) {
	if (!el) return "";
	let t = (el.textContent || "").trim();
	let sib = el.nextElementSibling;
	let steps = 0;
	while (sib && steps < 2 && /^(P|UL|OL|DIV|SECTION)$/i.test(sib.tagName)) {
		const txt = (sib.textContent || "").trim();
		if (txt) t += "\n" + txt;
		sib = sib.nextElementSibling;
		steps++;
	}
	return t.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}

async function actReadPage() {
	const secs = getReadableSections();
	if (secs.length === 0) {
		const all = (document.querySelector("main, [role='main'], body")?.textContent || "").trim();
		const chunk = all.slice(0, 900);
		await speak(makeSpokenSection(chunk), { mode: "read" });
		await remember({ lastIntent: intents.READ_PAGE, lastSectionId: null, expectingYesNo: false, pendingAction: null });
		return { ok: true, message: "Read page (fallback blob)" };
	}

	const first = secs[0];
	const out = textFromNode(first.el).slice(0, 1200);
	await speak(makeSpokenSection(out), { mode: "read" });
	await remember({
		lastIntent: intents.READ_PAGE,
		lastSectionId: first.id,
		expectingYesNo: false,
		pendingAction: null,
	});
	return { ok: true, message: `Read section: ${first.id}` };
}

	// =============================================================================
	// 16.5) Summarize page (key requirement for blind / visually impaired users)
	// =============================================================================

	async function actSummarizePage() {
		try {
			const { title, text } = extractPageMainText(document);
			if (!text || text.trim().length < 20) {
				await speak("I can only see the page title right now. Try opening the announcement details, then say summarize again.", {
					mode: "say",
				});
				return { ok: false, message: "No body text found to summarize" };
			}

			const summary = await summarizeTextForSpeech(text, { maxSentences: 2 });
			if (!summary) {
				await speak("I couldn't find anything important to summarize on this page.", { mode: "say" });
				return { ok: false, message: "Summarizer produced empty output" };
			}

			const prefix = title ? `Summary of ${title}. ` : "Summary. ";
			await speak(prefix + summary, { mode: "say" });
			await remember({ lastIntent: intents.SUMMARIZE_PAGE, lastSectionId: null, expectingYesNo: false, pendingAction: null });
			return { ok: true, message: "Summarized page" };
		} catch (e) {
			console.warn("[actSummarizePage] failed:", e);
			await speak("Sorry—something went wrong while summarizing this page.", { mode: "say" });
			return { ok: false, message: "Summarize failed" };
		}
	}
async function actReadNext() {
	const secs = getReadableSections();
	const state = await mem.get();
	const lastId = state.lastSectionId;

	if (secs.length === 0) {
		await speak("I don't see sections here. Want me to read the page?", { mode: "say" });
		await remember({ expectingYesNo: true, pendingAction: "READ_PAGE" });
		return { ok: false, message: "No sections" };
	}

	let idx = 0;
	if (lastId) idx = Math.max(0, secs.findIndex((s) => s.id === lastId) + 1);

	if (idx >= secs.length) {
		await speak("That's the end.", { mode: "say" });
		await remember({ expectingYesNo: false, pendingAction: null });
		return { ok: false, message: "End of sections" };
	}

	const sec = secs[idx];
	const out = textFromNode(sec.el).slice(0, 1200);
	await speak(makeSpokenSection(out), { mode: "read" });
	await remember({ lastIntent: intents.READ_NEXT, lastSectionId: sec.id, expectingYesNo: false, pendingAction: null });
	return { ok: true, message: `Read section: ${sec.id}` };
}

async function actRepeat() {
	const state = await mem.get();
	if (state.lastSectionId) {
		const el = document.getElementById(state.lastSectionId);
		if (el) {
			const out = textFromNode(el).slice(0, 1200);
			await speak(makeSpokenSection(out), { mode: "read" });
			return { ok: true, message: `Repeated section: ${state.lastSectionId}` };
		}
	}
	const h1 = document.querySelector("main h1, [role='main'] h1, h1");
	const title = (h1?.textContent || document.title || "this page").trim();
	await speak(`Repeating: ${title}.`, { mode: "say" });
	return { ok: true, message: "Repeated title" };
}

async function actHelp() {
	const msg =
		"Try: open dashboard. Go back. Open grades. Open assignments. Open modules. Open quizzes. Open files. Open courses. Open course 1040. Open homework 2. Read the page. Next section. Repeat.";
	await speak(msg, { mode: "say" });
	return { ok: true, message: "Help spoken" };
}

async function actAffirmDeny(isYes) {
	const state = await mem.get();

	if (state.expectingChoice) {
		await speak("Say option 1, option 2, and so on.", { mode: "say" });
		return { ok: false, message: "Expecting choice, got yes/no" };
	}

	if (!state.expectingYesNo) {
		await speak(isYes ? "Okay." : "Alright.", { mode: "say" });
		return { ok: true, message: "Ambient yes/no" };
	}

	const pending = state.pendingAction;
	await remember({ expectingYesNo: false, pendingAction: null });

	if (!isYes) {
		if (pending === "OPEN_COURSE_CONFIRM") {
			await mem.set({ pendingHref: null, pendingLabel: null });
			return await actListCoursesFallback("No problem. Here are your courses.");
		}

		await speak("Canceled.", { mode: "say" });
		return { ok: true, message: "Canceled pending action" };
	}

	if (pending === "READ_PAGE") return await actReadPage();
	if (pending === "OPEN_DASHBOARD") return await actOpenDashboard();
	if (pending === "READ_ASSIGNMENTS_SUMMARY") return await actReadAssignmentsSummary();
	if (pending === "OPEN_COURSES") return await actOpenCourses();

	if (pending === "OPEN_COURSE_CONFIRM") {
		const href = state.pendingHref;
		const label = state.pendingLabel || "that course";
		await mem.set({ pendingHref: null, pendingLabel: null });

		if (href) {
			await speak(`Opening ${label}.`, { mode: "say" });
			window.location.href = href;
			await remember({ activeCourseHref: href });
			return { ok: true, message: "Opened confirmed course" };
		}
		return await actListCoursesFallback("I lost the course link. Here are your courses.");
	}

	if (pending === "OPEN_COURSES_THEN_SEARCH") {
		const num = state.pendingCourseNum;
		await mem.set({ pendingCourseNum: null });
		await speak("Opening courses.", { mode: "say" });
		await actOpenCourses();
		await speak(`When it loads, say: open course ${num}.`, { mode: "say" });
		return { ok: true, message: "Opened courses then prompted to retry" };
	}

	await speak("Okay.", { mode: "say" });
	return { ok: true, message: "No pending action matched" };
}

// =============================================================================
// 17) Credential setup overlay (injected into current page)
// =============================================================================

async function injectCredentialSetupOverlay() {
	// Remove any existing overlay
	document.getElementById("convox-setup-overlay")?.remove();

	const overlay = document.createElement("div");
	overlay.id = "convox-setup-overlay";
	overlay.style.cssText = `
		position: fixed; inset: 0; z-index: 2147483647;
		background: rgba(0,0,0,0.85);
		display: flex; align-items: center; justify-content: center;
		font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
	`;

	overlay.innerHTML = `
		<div style="
			background: #111; border: 3px solid #fff; border-radius: 12px;
			padding: 36px 40px; width: 400px; color: #fff;
		">
			<h2 style="color:#ffff00; font-size:1.3rem; margin:0 0 8px;">Convox – Login Setup</h2>
			<p style="color:#fff; font-size:0.9rem; margin:0 0 24px; line-height:1.5;">
				Say or type your credentials. They will be saved for future logins.
			</p>

			<label style="display:block; color:#ffff00; font-size:0.8rem; font-weight:700;
				text-transform:uppercase; letter-spacing:0.04em; margin-bottom:6px;">
				Username / EUID
			</label>
			<input id="convox-un" type="text" placeholder="e.g. abc1234" style="
				width:100%; padding:10px 14px; background:#000; border:2px solid #fff;
				border-radius:6px; color:#fff; font-size:1rem; margin-bottom:20px;
				outline:none; box-sizing:border-box;
			"/>

			<label style="display:block; color:#ffff00; font-size:0.8rem; font-weight:700;
				text-transform:uppercase; letter-spacing:0.04em; margin-bottom:6px;">
				Password
			</label>
			<input id="convox-pw" type="password" placeholder="Your Canvas password" style="
				width:100%; padding:10px 14px; background:#000; border:2px solid #fff;
				border-radius:6px; color:#fff; font-size:1rem; margin-bottom:24px;
				outline:none; box-sizing:border-box;
			"/>

			<div style="display:flex; gap:10px;">
				<button id="convox-save-btn" style="
					flex:1; padding:12px; background:#ffff00; color:#000; border:none;
					border-radius:6px; font-size:1rem; font-weight:700; cursor:pointer;
				">Save</button>
				<button id="convox-cancel-btn" style="
					flex:1; padding:12px; background:#000; color:#fff;
					border:2px solid #fff; border-radius:6px; font-size:1rem;
					font-weight:700; cursor:pointer;
				">Cancel</button>
			</div>

			<div id="convox-setup-status" style="
				margin-top:14px; font-size:0.85rem; text-align:center; min-height:20px; color:#00ff00;
			"></div>

			<div style="margin-top:16px; background:#000; border:2px solid #fff;
				border-radius:6px; padding:12px; font-size:0.82rem; color:#fff; line-height:2;">
				<div><span style="background:#ffff00;color:#000;font-weight:700;
					border-radius:3px;padding:1px 6px;font-family:monospace;margin-right:6px;">
					set username [value]</span> set your username</div>
				<div><span style="background:#ffff00;color:#000;font-weight:700;
					border-radius:3px;padding:1px 6px;font-family:monospace;margin-right:6px;">
					set password [value]</span> set your password</div>
				<div><span style="background:#ffff00;color:#000;font-weight:700;
					border-radius:3px;padding:1px 6px;font-family:monospace;margin-right:6px;">
					save</span> save and close</div>
				<div><span style="background:#ffff00;color:#000;font-weight:700;
					border-radius:3px;padding:1px 6px;font-family:monospace;margin-right:6px;">
					cancel</span> close without saving</div>
			</div>
		</div>
	`;

	document.body.appendChild(overlay);

	const unInput    = overlay.querySelector("#convox-un");
	const pwInput    = overlay.querySelector("#convox-pw");
	const saveBtn    = overlay.querySelector("#convox-save-btn");
	const cancelBtn  = overlay.querySelector("#convox-cancel-btn");
	const statusEl   = overlay.querySelector("#convox-setup-status");

	function setStatus(msg, color = "#00ff00") {
		statusEl.style.color = color;
		statusEl.textContent = msg;
	}

	async function saveAndClose() {
		const username = unInput.value.trim();
		const password = pwInput.value.trim();
		if (!username && !password) {
			setStatus("Please enter a username or password.", "#ff4444");
			await speak("Please enter a username or password.", { mode: "say" });
			return;
		}
		await new Promise((res) => chrome.storage.local.set({ convox_credentials: { username, password } }, res));
		setStatus("Saved! Logging you in now...");
		overlay.remove();

		// Fill the login form and submit
		const uField = findFirst(USERNAME_SELECTORS);
		const pField = findFirst(PASSWORD_SELECTORS);
		if (uField && username) setNativeValue(uField, username);
		if (pField && password) setNativeValue(pField, password);

		await speak("Credentials saved. Logging you in now.", { mode: "say" });

		const submitBtn = findFirst(SUBMIT_SELECTORS);
		if (submitBtn) {
			submitBtn.click();
			sessionStorage.setItem("canvoxNavigation", JSON.stringify({
				message: "Successfully logged in to your account. You are now on the Canvas dashboard.",
				timestamp: Date.now(),
			}));
		}
	}

	saveBtn.addEventListener("click", saveAndClose);
	cancelBtn.addEventListener("click", () => {
		overlay.remove();
		speak("Setup cancelled.", { mode: "say" });
	});

	// Voice control for the overlay
	const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
	let overlayRec = null;

	function startOverlayRecognition() {
		if (!SR) return;
		overlayRec = new SR();
		overlayRec.lang = "en-US";
		overlayRec.continuous = false;
		overlayRec.interimResults = false;

		overlayRec.onresult = async (e) => {
			const t = (e.results[0]?.[0]?.transcript || "").toLowerCase().trim();

			const unMatch = t.match(/\b(?:set\s+)?(?:username|user|euid)\s+(?:is\s+)?(\S+)/);
			const pwMatch = t.match(/\b(?:set\s+)?password\s+(?:is\s+)?(\S+)/);

			if (unMatch) {
				unInput.value = unMatch[1];
				unInput.style.borderColor = "#ffff00";
				await speak(`Username set to ${unMatch[1]}. Now say set password, then your password, or say save.`, { mode: "say" });
			} else if (pwMatch) {
				pwInput.value = pwMatch[1];
				pwInput.style.borderColor = "#ffff00";
				await speak("Password set. Say save to finish.", { mode: "say" });
			} else if (/\b(save|done|confirm)\b/.test(t)) {
				await saveAndClose();
				return;
			} else if (/\b(cancel|close|exit)\b/.test(t)) {
				overlay.remove();
				await speak("Setup cancelled.", { mode: "say" });
				return;
			} else {
				await speak("Say set username, then your username, or set password, then your password.", { mode: "say" });
			}

			if (document.getElementById("convox-setup-overlay")) startOverlayRecognition();
		};

		overlayRec.onerror = () => {
			if (document.getElementById("convox-setup-overlay")) startOverlayRecognition();
		};
		overlayRec.onend = () => {
			if (document.getElementById("convox-setup-overlay") && !window.speechSynthesis.speaking) {
				startOverlayRecognition();
			}
		};

		overlayRec.start();
	}

	// Focus username field and prompt
	unInput.focus();
	unInput.style.borderColor = "#ffff00";
	await speak("Please say or type your username, then say or type your password, then say save.", { mode: "say" });
	startOverlayRecognition();
}

async function actOpenSettings() {
	await speak("Opening settings.", { mode: "say" });
	await injectCredentialSetupOverlay();
	return { ok: true, message: "Opened settings overlay" };
}

// =============================================================================
// 17.5) Log in
// =============================================================================

async function actLogIn(slots = {}) {
	const transcript = slots.utterance || "";

	// ── Selector sets covering Canvas native + UNT SSO (Shibboleth) ──────────
	const USERNAME_SELECTORS = [
		"#pseudonym_session_unique_id",   // Canvas native
		"input[name='pseudonym_session[unique_id]']",
		"#username",                       // Shibboleth SSO
		"input[name='username']",
		"input[name='j_username']",
		"input[type='email']",
		"input[autocomplete='username']",
	];
	const PASSWORD_SELECTORS = [
		"#pseudonym_session_password",    // Canvas native
		"input[name='pseudonym_session[password]']",
		"#password",                       // Shibboleth SSO
		"input[name='password']",
		"input[name='j_password']",
		"input[type='password']",
		"input[autocomplete='current-password']",
	];
	const SUBMIT_SELECTORS = [
		".Button--login",                  // Canvas native
		"button[type='submit']",
		"input[type='submit']",
		"#submitbutton",                   // Shibboleth
		"button[name='_eventId_proceed']", // Shibboleth SSO proceed
	];
	const REMEMBER_SELECTORS = [
		"#pseudonym_session_remember_me",
		"input[name='_shib_idp_revokeConsent']",
		"input[type='checkbox']",
	];

	function findFirst(selectors) {
		for (const sel of selectors) {
			const el = document.querySelector(sel);
			if (el) return el;
		}
		return null;
	}

	// Fires native input + change events so React/controlled inputs register the value
	function setNativeValue(el, value) {
		const nativeInput = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
		nativeInput?.set?.call(el, value);
		el.dispatchEvent(new Event("input", { bubbles: true }));
		el.dispatchEvent(new Event("change", { bubbles: true }));
	}

	// ── 1) Confirm a login form is present on this page ───────────────────────
	const usernameField = findFirst(USERNAME_SELECTORS);
	const passwordField = findFirst(PASSWORD_SELECTORS);

	if (!usernameField && !passwordField) {
		await speak("I don't see a login form on this page.", { mode: "say" });
		return { ok: false, message: "No login form found on current page" };
	}

	// ── 2) No transcript yet — prompt the user ────────────────────────────────
	if (!transcript) {
		await speak("Say your username and password, say submit to log in, or say stay signed in to toggle that option.", { mode: "say" });
		return { ok: true, message: "Prompted user for login speech" };
	}

	// ── 3) "submit" / "log in" / "sign in" ───────────────────────────────────
	const u = normalize(transcript);
	if (/\b(submit|go|enter|done)\b/.test(u)) {
		const submitBtn = findFirst(SUBMIT_SELECTORS);
		if (submitBtn) {
			submitBtn.click();
			sessionStorage.setItem(
				"canvoxNavigation",
				JSON.stringify({
					message: "Successfully logged in to your account. You are now on the Canvas dashboard.",
					timestamp: Date.now(),
				})
			);
			return { ok: true, message: "Submitted login form" };
		}
		await speak("I couldn't find the login button.", { mode: "say" });
		return { ok: false, message: "Login button not found" };
	}

	// ── 4) "stay signed in" / "remember me" ──────────────────────────────────
	if (/\b(stay|remember|keep me|persist)\b/.test(u)) {
		const rememberMe = findFirst(REMEMBER_SELECTORS);
		if (rememberMe) {
			rememberMe.checked = !rememberMe.checked;
			rememberMe.dispatchEvent(new Event("change", { bubbles: true }));
			await speak("Toggled stay signed in.", { mode: "say" });
			return { ok: true, message: "Toggled remember-me checkbox" };
		}
		await speak("I couldn't find the stay signed in checkbox.", { mode: "say" });
		return { ok: false, message: "Remember-me checkbox not found" };
	}

	// ── 5) Read saved credentials from storage and fill fields ───────────────
	const stored = await new Promise((res) => chrome.storage.local.get("convox_credentials", (d) => res(d?.convox_credentials || null)));

	if (!stored?.username && !stored?.password) {
		await speak("No saved credentials found. Let's set them up now.", { mode: "say" });
		await injectCredentialSetupOverlay();
		return { ok: false, message: "No credentials — showed setup overlay" };
	}

	const uField = findFirst(USERNAME_SELECTORS);
	const pField = findFirst(PASSWORD_SELECTORS);

	if (uField && stored.username) setNativeValue(uField, stored.username);
	if (pField && stored.password) setNativeValue(pField, stored.password);

	await speak("Logging you in now.", { mode: "say" });

	const submitBtn = findFirst(SUBMIT_SELECTORS);
	if (submitBtn) {
		submitBtn.click();
		sessionStorage.setItem("canvoxNavigation", JSON.stringify({
			message: "Successfully logged in to your account. You are now on the Canvas dashboard.",
			timestamp: Date.now(),
		}));
		return { ok: true, message: "Filled credentials and submitted" };
	}

	await speak("Credentials entered but I couldn't find the login button. Please press enter to continue.", { mode: "say" });
	return { ok: true, message: "Filled credentials, submit button not found" };
}

function firstMatch(selectors, root = document) {
	for (const sel of selectors) {
		const el = root.querySelector(sel);
		if (el && isVisible(el)) return el;
	}
	return null;
}

function findVisibleButtonByText(re, root = document) {
	return (
		Array.from(root.querySelectorAll("button, [role='button']")).find(
			(btn) => isVisible(btn) && re.test((btn.textContent || "").trim()),
		) || null
	);
}

function writeField(el, text) {
	if (!el) return false;
	const value = String(text || "").trim();
	if (!value) return false;

	el.focus?.();
	if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
		el.value = value;
		el.dispatchEvent(new Event("input", { bubbles: true }));
		el.dispatchEvent(new Event("change", { bubbles: true }));
		return true;
	}

	if (el.isContentEditable) {
		el.textContent = value;
		el.dispatchEvent(new Event("input", { bubbles: true }));
		return true;
	}

	return false;
}

function isCanvasInboxPage() {
	return /\/conversations\b/i.test(window.location.pathname) || /conversations/i.test(window.location.href);
}

function isCanvasAnnouncementsPage() {
	return /\/announcements\b/i.test(window.location.pathname) || /announcements/i.test(window.location.href);
}

function splitSpeechChunks(text, maxLen = 900) {
	const src = String(text || "").trim();
	if (!src) return [];
	if (src.length <= maxLen) return [src];

	const chunks = [];
	let rest = src;
	while (rest.length > maxLen) {
		let cut = rest.lastIndexOf(". ", maxLen);
		if (cut < Math.floor(maxLen * 0.45)) cut = rest.lastIndexOf("; ", maxLen);
		if (cut < Math.floor(maxLen * 0.45)) cut = rest.lastIndexOf(", ", maxLen);
		if (cut < Math.floor(maxLen * 0.45)) cut = rest.lastIndexOf(" ", maxLen);
		if (cut < 120) cut = maxLen;
		const part = rest.slice(0, cut + 1).trim();
		if (part) chunks.push(part);
		rest = rest.slice(cut + 1).trim();
	}
	if (rest) chunks.push(rest);
	return chunks;
}

async function speakAnnouncementBodyFull(bodyText) {
	const chunks = splitSpeechChunks(bodyText, 900);
	for (const chunk of chunks) {
		await speak(chunk, { raw: true, mode: "read" });
	}
}

function isReadRecentMessageCommand(text) {
	const lower = String(text || "").toLowerCase();
	return (
		/\b(read|open|check)\b/.test(lower) &&
		/\b(recent|latest|last|newest|most recent)\b/.test(lower) &&
		/\b(message|email|inbox)\b/.test(lower)
	);
}

function cleanSubjectText(subjectText) {
	return String(subjectText || "")
		.replace(/\s+/g, " ")
		.replace(/\b(mark as unread|mark as read|reply|forward)\b.*$/i, "")
		.trim();
}

function cleanSenderName(senderText) {
	let s = String(senderText || "").replace(/\s+/g, " ").trim();
	if (!s) return "";
	if (s.includes(",")) s = s.split(",")[0].trim();
	if (/\s+and\s+/i.test(s)) s = s.split(/\s+and\s+/i)[0].trim();
	return s;
}

function isBadSubjectText(text) {
	const t = String(text || "").trim().toLowerCase();
	if (!t) return true;
	if (/^\d+\s*messages?$/.test(t)) return true;
	if (/message.*not selected/.test(t)) return true;
	if (/^(inbox|all courses|search|compose|settings|reply|forward)$/.test(t)) return true;
	return false;
}

function isDateLikeLine(text) {
	return /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+\d{4}\b/i.test(String(text || ""));
}

function isCourseMetaLine(text) {
	return /\bsection\b|\bspring\b|\bfall\b|\bsummer\b|\bwinter\b/i.test(String(text || ""));
}

function extractSenderSubjectFromRow(row) {
	const senderSel = row.querySelector(".css-c31sii-text, [data-testid*='participants' i], [data-testid*='sender' i]");
	const subjectSel = row.querySelector(
		".css-cv5a3j-view-heading, [data-testid*='subject' i], [data-testid*='message-title' i]",
	);

	let sender = senderSel?.textContent?.trim() || "";
	let subject = subjectSel?.textContent?.trim() || "";

	const lines = String(row.innerText || "")
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);

	if (!sender) {
		sender =
			lines.find((l) => !isDateLikeLine(l) && !isCourseMetaLine(l) && /,| and | & |[A-Z][a-z]+\s+[A-Z][a-z]+/.test(l)) ||
			lines.find((l) => !isDateLikeLine(l) && !isCourseMetaLine(l)) ||
			"Unknown sender";
	}
	if (!subject) {
		subject =
			lines.find((l) => {
				const n = normalizeChoiceText(l);
				return (
					n &&
					!isBadSubjectText(l) &&
					!isDateLikeLine(l) &&
					!isCourseMetaLine(l) &&
					n !== normalizeChoiceText(sender) &&
					l.length > 2 &&
					l.length < 140
				);
			}) || "No subject";
	}

	return {
		sender: cleanSenderName(sender) || "Unknown sender",
		subject: cleanSubjectText(subject) || "No subject",
	};
}

function collectInboxRows() {
	return Array.from(
		document.querySelectorAll("[data-testid='conversationListItem-Item'], [data-testid*='conversationListItem' i]"),
	)
		.filter(isVisible)
		.map((row) => {
			const { sender, subject } = extractSenderSubjectFromRow(row);
			return { row, sender, subject };
		});
}

function findOpenedMessagePanel() {
	const detailNodes = Array.from(
		document.querySelectorAll(
			".css-103zv00-view-flexItem, [data-testid*='message-detail' i], [class*='message-detail' i], main, [role='main']",
		),
	).filter((el) => {
		if (!isVisible(el)) return false;
		const r = el.getBoundingClientRect?.();
		return !r || (r.left >= window.innerWidth * 0.28 && r.width >= 260 && r.height >= 120);
	});

	return detailNodes.sort((a, b) => (b.innerText || "").length - (a.innerText || "").length)[0] || null;
}

function fallbackBodyFromPanelText(panel, subject, sender) {
	const lines = String(panel?.innerText || "")
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);

	const subjectNorm = normalizeChoiceText(subject);
	const senderNorm = normalizeChoiceText(sender);
	const startIdx = Math.max(
		lines.findIndex((l) => normalizeChoiceText(cleanSubjectText(l)) === subjectNorm),
		lines.findIndex((l) => normalizeChoiceText(cleanSenderName(l)) === senderNorm),
		lines.findIndex((l) => isDateLikeLine(l)),
	);

	return lines
		.slice(startIdx >= 0 ? startIdx + 1 : 0)
		.filter((l) => {
			const n = normalizeChoiceText(l);
			if (!n) return false;
			if (isBadSubjectText(l)) return false;
			if (isDateLikeLine(l)) return false;
			if (isCourseMetaLine(l)) return false;
			if (n === subjectNorm) return false;
			if (n === senderNorm) return false;
			if (/^(inbox|all courses|search|compose|settings|reply|forward)$/.test(n)) return false;
			return true;
		})
		.slice(0, 30)
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
}

function fallbackBodyFromRightPaneText(subject, sender) {
	const subjectNorm = normalizeChoiceText(subject);
	const senderNorm = normalizeChoiceText(sender);

	const nodes = Array.from(document.querySelectorAll("article, section, main, [role='main'], div"))
		.filter(isVisible)
		.filter((el) => {
			const r = el.getBoundingClientRect?.();
			if (!r) return false;
			return r.left >= window.innerWidth * 0.28 && r.width >= 260 && r.height >= 120;
		})
		.filter((el) => (el.innerText || "").trim().length > 40)
		.sort((a, b) => (b.innerText || "").length - (a.innerText || "").length)
		.slice(0, 8);

	for (const node of nodes) {
		const lines = String(node.innerText || "")
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean);

		if (!lines.length) continue;

		const startIdx = Math.max(
			lines.findIndex((l) => normalizeChoiceText(cleanSubjectText(l)) === subjectNorm),
			lines.findIndex((l) => normalizeChoiceText(cleanSenderName(l)) === senderNorm),
			lines.findIndex((l) => isDateLikeLine(l)),
		);

		const text = lines
			.slice(startIdx >= 0 ? startIdx + 1 : 0)
			.filter((l) => {
				const n = normalizeChoiceText(l);
				if (!n) return false;
				if (isBadSubjectText(l)) return false;
				if (isDateLikeLine(l)) return false;
				if (isCourseMetaLine(l)) return false;
				if (n === subjectNorm) return false;
				if (n === senderNorm) return false;
				if (/^(inbox|all courses|search|compose|settings|reply|forward)$/.test(n)) return false;
				return true;
			})
			.slice(0, 30)
			.join(" ")
			.replace(/\s+/g, " ")
			.trim();

		if (text) return text;
	}

	return "";
}

function bruteForceBodyFromViewport(subject, sender) {
	const subjectNorm = normalizeChoiceText(subject);
	const senderNorm = normalizeChoiceText(sender);

	const candidates = Array.from(document.querySelectorAll("div, section, article, main, p, span"))
		.filter(isVisible)
		.filter((el) => {
			const r = el.getBoundingClientRect?.();
			if (!r) return false;
			return r.left >= window.innerWidth * 0.33 && r.width >= 120 && r.height >= 20;
		})
		.map((el) => ({
			el,
			text: String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim(),
		}))
		.filter((x) => x.text.length >= 2)
		.sort((a, b) => b.text.length - a.text.length);

	for (const c of candidates.slice(0, 20)) {
		const lines = c.text
			.split(/\n+/)
			.map((l) => l.trim())
			.filter(Boolean);

		const text = lines
			.filter((l) => {
				const n = normalizeChoiceText(l);
				if (!n) return false;
				if (isBadSubjectText(l)) return false;
				if (isDateLikeLine(l)) return false;
				if (isCourseMetaLine(l)) return false;
				if (n === subjectNorm) return false;
				if (n === senderNorm) return false;
				if (/^(inbox|all courses|search|compose|settings|reply|forward|43 more)$/.test(n)) return false;
				return true;
			})
			.slice(0, 20)
			.join(" ")
			.replace(/\s+/g, " ")
			.trim();

		if (text.length >= 8) return text;
	}

	return "";
}

function readCurrentMessageDetail() {
	const panel = findOpenedMessagePanel();
	if (!panel) return null;

	const lines = String(panel.innerText || "")
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);

	let subject =
		panel
			.querySelector("[data-testid='message-detail-header-desktop'], [data-testid*='message-detail-header' i], h1, h2")
			?.textContent?.trim() || "";
	subject = cleanSubjectText(subject);
	if (isBadSubjectText(subject) || isDateLikeLine(subject) || isCourseMetaLine(subject)) subject = "";

	let sender =
		panel
			.querySelector(
				"span.css-g5lcut-text, [data-testid*='author' i], [class*='author' i], [data-testid*='participants' i]",
			)
			?.textContent?.trim() || "";
	sender = cleanSenderName(sender);
	if (isDateLikeLine(sender) || isCourseMetaLine(sender)) sender = "";

	if (!subject) {
		subject =
			lines.find((l) => {
				const n = normalizeChoiceText(cleanSubjectText(l));
				return (
					n &&
					!isBadSubjectText(l) &&
					!isDateLikeLine(l) &&
					!isCourseMetaLine(l) &&
					n !== normalizeChoiceText(sender) &&
					l.length > 2 &&
					l.length < 140
				);
			}) || "No subject";
		subject = cleanSubjectText(subject);
	}

	if (!sender) {
		sender =
			lines.find(
				(l) =>
					!isDateLikeLine(l) &&
					!isCourseMetaLine(l) &&
					/,| and | & |[A-Z][a-z]+\s+[A-Z][a-z]+/.test(l) &&
					normalizeChoiceText(l) !== normalizeChoiceText(subject),
			) ||
			"Unknown sender";
		sender = cleanSenderName(sender);
	}

	const senderNorm = normalizeChoiceText(sender);
	const subjectNorm = normalizeChoiceText(subject);
	const bodyNodes = Array.from(
		panel.querySelectorAll(
			"[data-testid*='message-body' i], [data-testid*='message-content' i], .message, .message-content, .user_content, p, div",
		),
	).filter(isVisible);
	const directBodyText = bodyNodes
		.map((el) => (el.textContent || "").trim())
		.filter(Boolean)
		.filter((l) => {
			const n = normalizeChoiceText(l);
			if (!n) return false;
			if (isBadSubjectText(l)) return false;
			if (isDateLikeLine(l)) return false;
			if (isCourseMetaLine(l)) return false;
			if (n === subjectNorm) return false;
			if (n === senderNorm) return false;
			return true;
		})
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();

	if (directBodyText) {
		return {
			subject: subject || "No subject",
			sender: sender || "Unknown sender",
			bodyPreview: directBodyText,
		};
	}

	const bodyPreview =
		fallbackBodyFromPanelText(panel, subject, sender) ||
		fallbackBodyFromRightPaneText(subject, sender) ||
		bruteForceBodyFromViewport(subject, sender);

	return {
		subject: subject || "No subject",
		sender: sender || "Unknown sender",
		bodyPreview,
	};
}

async function readCurrentMessageDetailWithRetry() {
	let detail = readCurrentMessageDetail();
	if (detail?.bodyPreview) return detail;
	for (const ms of [600, 900, 1200]) {
		await delay(ms);
		detail = readCurrentMessageDetail();
		if (detail?.bodyPreview) return detail;
	}
	return detail;
}

async function actReadRecentMessage() {
	if (!isCanvasInboxPage()) {
		await actOpenInbox();
		await speak("Opening inbox first. Then say read recent message again.", { mode: "say" });
		return { ok: true, message: "Opened inbox for recent message" };
	}

	const all = collectInboxRows();
	if (!all.length) {
		await speak("I can't find messages right now.", { mode: "say" });
		return { ok: false, message: "No inbox rows found" };
	}

	const target = all[0];
	target.row.click?.();
	await delay(700);

	const detail = await readCurrentMessageDetailWithRetry();
	const sender = cleanSenderName(detail?.sender || target.sender) || "Unknown sender";
	const subject = cleanSubjectText(detail?.subject || target.subject) || "No subject";

	await speak(`Opening your most recent message. Subject ${subject}. From ${sender}.`, { mode: "say" });
	if (detail?.bodyPreview) {
		await speak(`Message: ${detail.bodyPreview}`, { raw: true, mode: "read" });
	}

	return { ok: true, message: "Read recent message" };
}

function hasAnnouncementKeyword(text) {
	return /\b(announcement|announcements|annoucement|annoucements|announcemnet|announcemnets)\b/i.test(String(text || ""));
}

function normalizeAnnouncementTitle(text) {
	return String(text || "")
		.replace(/^unread,\s*/i, "")
		.replace(/\s+/g, " ")
		.trim();
}

function extractAnnouncementTitleFromRow(row) {
	if (!row) return "";
	const heading = row.querySelector(
		"h1, h2, h3, h4, [data-testid*='title' i], [class*='title' i], a[href*='/announcements/']",
	);
	const headingText = normalizeAnnouncementTitle(heading?.textContent || "");
	if (headingText && !/^posted on:?$/i.test(headingText)) return headingText;

	const lines = String(row.innerText || "")
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);
	for (const line of lines) {
		const t = normalizeAnnouncementTitle(line);
		if (!t) continue;
		if (/^all sections$/i.test(t)) continue;
		if (/^posted on:?/i.test(t)) continue;
		if (t.length < 4) continue;
		return t;
	}
	return "";
}

function extractAnnouncementBodyText(root) {
	if (!root) return "";
	const bodyNode =
		root.querySelector?.(
			"[data-testid='announcement-content'], .ic-Announcement__content, .ic-announcement-row__content.user_content.enhanced, .ic-announcement-row__content, .user_content.enhanced, .user_content",
		) || root;
	return String(bodyNode?.innerText || bodyNode?.textContent || "")
		.replace(/\r/g, "")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/\s+/g, " ")
		.trim();
}

function collectAnnouncementRows() {
	const items = [];
	const byKey = new Map();
	const anchors = Array.from(document.querySelectorAll("a[href*='/announcements/']")).filter(isVisible);
	const rowNodes = Array.from(
		document.querySelectorAll(
			".ic-announcement-row, [class*='announcement-row' i], [data-testid*='announcement' i], li, article, section",
		),
	).filter((row) => {
		if (!isVisible(row)) return false;
		const t = String(row.innerText || "").toLowerCase();
		return /\bposted on\b/.test(t) || /\/announcements\//.test(String(row.innerHTML || ""));
	});

	const pushItem = (node, linkNode = null, forcedRow = null, forcedTitle = "") => {
		if (!node && !forcedRow) return;
		const row =
			forcedRow ||
			(linkNode || node).closest?.(
				"[data-testid*='announcement' i], .ic-announcement-row, li, tr, article, section, .ig-row, .ic-item-row, div",
			) ||
			linkNode ||
			node;

		const raw = (forcedTitle || node?.textContent || "").replace(/\s+/g, " ").trim();
		const title = normalizeAnnouncementTitle(forcedTitle || raw || extractAnnouncementTitleFromRow(row));
		if (!title) return;

		const key = normalizeChoiceText(title);
		if (!key) return;

		const next = {
			title,
			row,
			link: linkNode || row?.querySelector?.("a[href*='/announcements/']") || null,
			url: linkNode?.href || row?.querySelector?.("a[href*='/announcements/']")?.href || "",
			bodyHint: extractAnnouncementBodyText(row),
		};

		if (byKey.has(key)) return;
		byKey.set(key, next);
		items.push(next);
	};

	for (const a of anchors) {
		const heading = a.querySelector("h1, h2, h3, h4") || a;
		pushItem(heading, a);
	}
	for (const row of rowNodes) {
		const title = extractAnnouncementTitleFromRow(row);
		if (!title) continue;
		const link = row.querySelector("a[href*='/announcements/']") || null;
		pushItem(link || row, link, row, title);
	}

	return items;
}

function isLikelyAnnouncementDetailPage() {
	const path = String(window.location.pathname || "");
	if (/\/announcements\/\d+/i.test(path)) return true;
	const hasExplicitDetail = !!document.querySelector(
		"[data-testid='announcement-content'], .ic-Announcement__content, .announcement_details, .show-content.user_content",
	);
	const rowCount = document.querySelectorAll(".ic-announcement-row, [class*='announcement-row' i]").length;
	return hasExplicitDetail && rowCount <= 1;
}

function isRecentAnnouncementTitlesCommand(text) {
	const u = String(text || "").toLowerCase();
	if (!hasAnnouncementKeyword(u)) return false;
	if (!/\b(read|list|show|tell)\b/.test(u)) return false;
	return /\b(recent|latest|newest|last)\b/.test(u);
}

function isReadOpenAnnouncementCommand(text) {
	const u = String(text || "").toLowerCase();
	if (!/\b(read|open)\b/.test(u)) return false;
	if (hasAnnouncementKeyword(u)) return true;
	return /^read\s+.+/.test(u) || /^open\s+.+/.test(u);
}

function readAnnouncementIndexFromUtterance(text) {
	const u = String(text || "").toLowerCase();
	const ordMap = {
		first: 0,
		second: 1,
		third: 2,
		fourth: 3,
		fifth: 4,
		sixth: 5,
		seventh: 6,
		eighth: 7,
		ninth: 8,
		tenth: 9,
	};

	const m1 = u.match(/\b(?:announcement|announcements?|number|no\.?|#)\s*(\d{1,2})(?:st|nd|rd|th)?\b/);
	if (m1) return Math.max(parseInt(m1[1], 10) - 1, 0);

	const m2 = u.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+announcement\b/);
	if (m2) return Math.max(parseInt(m2[1], 10) - 1, 0);

	for (const [word, idx] of Object.entries(ordMap)) {
		if (new RegExp(`\\bannouncement\\s+${word}\\b`).test(u)) return idx;
		if (new RegExp(`\\b${word}\\s+announcement\\b`).test(u)) return idx;
	}
	return null;
}

function extractAnnouncementTitleQuery(text) {
	const quoted = String(text || "").match(/["“']([^"”']+)["”']/);
	if (quoted?.[1]?.trim()) return quoted[1].trim();

	let q = String(text || "").trim();
	q = q.replace(/\b(read|open)\b/gi, "");
	q = q.replace(/\b(the|this|that|my)\b/gi, "");
	q = q.replace(/\b(announcement|announcements|annoucement|annoucements|announcemnet|announcemnets)\b/gi, "");
	q = q.replace(/\btitles?\b/gi, "");
	q = q.replace(/\s+/g, " ").trim();
	if (!q) return "";
	if (/^\d{1,2}(?:st|nd|rd|th)?$/i.test(q)) return "";
	if (/^(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)$/i.test(q)) return "";
	return q;
}

function scoreAnnouncementTitle(title, query) {
	const t = normalizeChoiceText(title);
	const q = normalizeChoiceText(query);
	if (!t || !q) return 0;
	if (t === q) return 100;
	if (t.startsWith(q)) return 40;
	if (t.includes(q)) return 24;
	if (q.includes(t) && t.length >= 6) return 12;
	let score = 0;
	for (const tok of q.split(" ").filter((x) => x.length > 2)) {
		if (t.includes(tok)) score += 4;
	}
	return score;
}

function findAnnouncementByTitle(rows, query) {
	const scored = (rows || [])
		.map((x) => ({ row: x, score: scoreAnnouncementTitle(x.title, query) }))
		.sort((a, b) => b.score - a.score);
	if (!scored.length || scored[0].score <= 0) return null;
	return scored[0].row;
}

function mapStoredItemsToTargets(items) {
	return (items || [])
		.map((x) => ({
			title: String(x?.title || "").trim(),
			url: String(x?.url || "").trim(),
			row: null,
			link: null,
			bodyHint: String(x?.bodyHint || "").trim(),
		}))
		.filter((x) => x.title);
}

function buildAnnouncementAssistState({ listedItems = [] } = {}) {
	const list = listedItems || [];
	return {
		awaitingPick: true,
		lastListedTitles: list.map((x) => x.title),
		lastListedItems: list.map((x) => ({
			title: x.title,
			url: x.url || x.link?.href || "",
			bodyHint: x.bodyHint || extractAnnouncementBodyText(x.row || null),
		})),
		listPath: String(window.location.pathname || ""),
		updatedAt: Date.now(),
	};
}

function readCurrentAnnouncementDetail(fallback = null) {
	const title = normalizeAnnouncementTitle(
		document.querySelector("main h1, [role='main'] h1, h1, [data-testid*='announcement-title' i]")?.textContent || "",
	);

	const candidates = Array.from(
		document.querySelectorAll(
			"[data-testid='announcement-content'], .ic-Announcement__content, .ic-announcement-row__content.user_content.enhanced, .ic-announcement-row__content, .user_content.enhanced, article, main",
		),
	)
		.filter(isVisible)
		.sort((a, b) => (b.innerText || "").length - (a.innerText || "").length);

	for (const c of candidates) {
		const body = extractAnnouncementBodyText(c);
		if (body && body.length > 60) {
			return { title: title || fallback?.title || "Announcement", body };
		}
	}

	const fallbackBody = extractAnnouncementBodyText(fallback?.row || null);
	return {
		title: title || fallback?.title || "Announcement",
		body: fallbackBody || "",
	};
}

async function readCurrentAnnouncementDetailWithRetry(fallback = null) {
	let detail = readCurrentAnnouncementDetail(fallback);
	if (detail?.body) return detail;
	for (const ms of [600, 900, 1200]) {
		await delay(ms);
		detail = readCurrentAnnouncementDetail(fallback);
		if (detail?.body) return detail;
	}
	return detail;
}

let _pendingAnnouncementResumeTimer = null;
let _pendingAnnouncementResumeRunning = false;

export async function resumePendingAnnouncementRead() {
	if (_pendingAnnouncementResumeRunning) return;
	_pendingAnnouncementResumeRunning = true;
	try {
		const st = await mem.get();
		const pending = st?.pendingAnnouncementRead;
		if (!pending) return;

		const ageMs = Date.now() - Number(pending.createdAt || 0);
		if (!Number.isFinite(ageMs) || ageMs > 3 * 60 * 1000) {
			await mem.set({ pendingAnnouncementRead: null });
			return;
		}

		const attempts = Number(pending.attempts || 0);
		const fallbackBody = String(pending.bodyHint || "").trim();
		const sourceUrl = String(pending.sourceUrl || "");
		const urlChanged = !!sourceUrl && sourceUrl !== String(window.location.href || "");

		if (fallbackBody.length >= 40 && (urlChanged || attempts >= 2)) {
			const fallbackTitle = pending.title || "Announcement";
			await speak(`Opening announcement. ${fallbackTitle}.`, { mode: "say" });
			await speakAnnouncementBodyFull(fallbackBody);
			await mem.set({ pendingAnnouncementRead: null });
			return;
		}

		if (!isLikelyAnnouncementDetailPage()) {
			if (attempts >= 12) {
				if (fallbackBody.length >= 40) {
					const fallbackTitle = pending.title || "Announcement";
					await speak(`Opening announcement. ${fallbackTitle}.`, { mode: "say" });
					await speakAnnouncementBodyFull(fallbackBody);
				}
				await mem.set({ pendingAnnouncementRead: null });
				return;
			}
			await mem.set({ pendingAnnouncementRead: { ...pending, attempts: attempts + 1 } });
			clearTimeout(_pendingAnnouncementResumeTimer);
			_pendingAnnouncementResumeTimer = setTimeout(() => {
				resumePendingAnnouncementRead().catch(() => {});
			}, 700);
			return;
		}

		const detail = await readCurrentAnnouncementDetailWithRetry({ title: pending.title || "" });
		if (!detail?.body || detail.body.length < 30) {
			if (fallbackBody.length >= 40) {
				const fallbackTitle = pending.title || "Announcement";
				await speak(`Opening announcement. ${fallbackTitle}.`, { mode: "say" });
				await speakAnnouncementBodyFull(fallbackBody);
				await mem.set({ pendingAnnouncementRead: null });
				return;
			}
			await mem.set({ pendingAnnouncementRead: { ...pending, attempts: attempts + 1 } });
			return;
		}

		const title = detail.title || pending.title || "Announcement";
		await speak(`Opening announcement. ${title}.`, { mode: "say" });
		await speakAnnouncementBodyFull(detail.body);
		await mem.set({ pendingAnnouncementRead: null });
	} finally {
		_pendingAnnouncementResumeRunning = false;
	}
}

function clickAnnouncementTarget(target) {
	if (!target) return false;
	if (target.link && isVisible(target.link)) {
		target.link.click?.();
		return true;
	}

	const row = target.row || null;
	const candidates = [
		row?.querySelector?.("a[href*='/announcements/']"),
		row?.querySelector?.("h1, h2, h3, h4"),
		row?.querySelector?.("[role='link'], [role='button'], a, button"),
	].filter(Boolean);

	for (const el of candidates) {
		try {
			if (!isVisible(el)) continue;
			el.click?.();
			return true;
		} catch {}
	}

	if (target.url) {
		try {
			window.location.assign(target.url);
			return true;
		} catch {}
	}

	return false;
}

async function openAndReadAnnouncement(target, label = "") {
	if (!target) return { ok: false, message: "No target announcement" };
	const rowBodyHint = String(target.bodyHint || extractAnnouncementBodyText(target.row || null) || "").trim();
	await mem.set({
		pendingAnnouncementRead: {
			title: target.title || "",
			bodyHint: rowBodyHint || "",
			sourceUrl: String(window.location.href || ""),
			createdAt: Date.now(),
			attempts: 0,
		},
	});

	clickAnnouncementTarget(target);
	await delay(550);

	const detail = await readCurrentAnnouncementDetailWithRetry(target);
	const onDetailPage = isLikelyAnnouncementDetailPage();
	const title = detail?.title || target.title || "Announcement";
	if (onDetailPage && detail?.body) {
		const prefix = label ? `Opening announcement ${label}.` : "Opening announcement.";
		await speak(`${prefix} ${title}.`, { mode: "say" });
		await speakAnnouncementBodyFull(detail.body);
		await mem.set({ pendingAnnouncementRead: null });
		return { ok: true, message: "Opened and read announcement" };
	}

	return { ok: true, message: "Announcement opening; awaiting destination page read" };
}

async function maybeHandleAnnouncementAssist(utterance) {
	const onAnnouncementsSurface = isCanvasAnnouncementsPage() || isLikelyAnnouncementDetailPage();
	if (!onAnnouncementsSurface) return null;

	const u = String(utterance || "").trim();
	const lower = u.toLowerCase();
	const state = await mem.get();
	const assist = state.announcementAssist || {};
	const rows = collectAnnouncementRows();

	if (isRecentAnnouncementTitlesCommand(u)) {
		await mem.set({ pendingAnnouncementRead: null });
		if (!rows.length) {
			await mem.set({ announcementAssist: null });
			await speak("I can't find announcements on this page right now.", { mode: "say" });
			return { intent: intents.QA_GENERAL, result: { ok: false, message: "No announcements found" } };
		}

		const recent = rows.slice(0, 5);
		const titlesLine = recent.map((x, i) => `${i + 1}: ${x.title}`).join(". ");
		await mem.set({ announcementAssist: buildAnnouncementAssistState({ listedItems: recent }) });
		await speak(`Here are the most recent announcements. ${titlesLine}`, { raw: true, mode: "read" });
		return {
			intent: intents.QA_GENERAL,
			result: { ok: true, message: "Read recent announcement titles", confidence: 0.35, reason: "auto-upgrade: unknown->QA_GENERAL (default)" },
		};
	}

	if (!isReadOpenAnnouncementCommand(lower)) return null;

	if (!rows.length && isLikelyAnnouncementDetailPage()) {
		const detail = await readCurrentAnnouncementDetailWithRetry(null);
		const title = detail?.title || "Announcement";
		await speak(`Opening announcement. ${title}.`, { mode: "say" });
		if (detail?.body) {
			await speakAnnouncementBodyFull(detail.body);
			return {
				intent: intents.QA_GENERAL,
				result: { ok: true, message: "Read current announcement detail", confidence: 0.35, reason: "auto-upgrade: unknown->QA_GENERAL (default)" },
			};
		}
		return {
			intent: intents.QA_GENERAL,
			result: { ok: false, message: "Current announcement body missing", confidence: 0.35, reason: "auto-upgrade: unknown->QA_GENERAL (default)" },
		};
	}

	const idx = readAnnouncementIndexFromUtterance(lower);
	if (idx != null) {
		const sameListPath = String(assist.listPath || "") === String(window.location.pathname || "");
		const storedList = mapStoredItemsToTargets(Array.isArray(assist.lastListedItems) ? assist.lastListedItems : []);
		let base = rows;
		if (sameListPath && assist.lastListedTitles?.length) {
			const ranked = assist.lastListedTitles
				.map((title) => findAnnouncementByTitle(rows, title))
				.filter(Boolean);
			if (ranked.length) base = ranked;
		}
		if ((!base || !base.length) && storedList.length) base = storedList;

		if (!base.length) {
			await speak("I can't find announcements on this page right now.", { mode: "say" });
			return {
				intent: intents.QA_GENERAL,
				result: { ok: false, message: "No announcements found", confidence: 0.35, reason: "auto-upgrade: unknown->QA_GENERAL (default)" },
			};
		}
		if (idx < 0 || idx >= base.length) {
			await speak(`Please say a number between 1 and ${Math.min(base.length, 10)}.`, { mode: "say" });
			return {
				intent: intents.QA_GENERAL,
				result: { ok: false, message: "Announcement index out of range", confidence: 0.35, reason: "auto-upgrade: unknown->QA_GENERAL (default)" },
			};
		}
		const res = await openAndReadAnnouncement(base[idx], String(idx + 1));
		return { intent: intents.QA_GENERAL, result: { ...res, confidence: 0.35, reason: "auto-upgrade: unknown->QA_GENERAL (default)" } };
	}

	const storedRows = mapStoredItemsToTargets(Array.isArray(assist.lastListedItems) ? assist.lastListedItems : []);
	const titleQuery = extractAnnouncementTitleQuery(u);
	if (titleQuery) {
		const target = findAnnouncementByTitle(rows.length ? rows : storedRows, titleQuery);
		if (!target) {
			await speak("I couldn't find an announcement with that title. Please say it again or use announcement number.", {
				mode: "say",
			});
			return {
				intent: intents.QA_GENERAL,
				result: { ok: false, message: "Announcement title not found", confidence: 0.35, reason: "auto-upgrade: unknown->QA_GENERAL (default)" },
			};
		}
		const res = await openAndReadAnnouncement(target);
		return { intent: intents.QA_GENERAL, result: { ...res, confidence: 0.35, reason: "auto-upgrade: unknown->QA_GENERAL (default)" } };
	}

	return null;
}

function getComposeDialog() {
	return (
		Array.from(document.querySelectorAll("[role='dialog']")).find((el) => {
			const t = (el.textContent || "").toLowerCase();
			return isVisible(el) && (t.includes("compose") || t.includes("message"));
		}) || null
	);
}

function isComposeDialogOpen() {
	return !!getComposeDialog();
}

function getComposeRoot() {
	return getComposeDialog() || document;
}

function looksLikeComposeTrigger(text) {
	const lower = String(text || "").toLowerCase();
	return (
		/\b(compose|write|create|start|send)\b.*\b(message|email|inbox)\b/.test(lower) ||
		/\bnew message\b/.test(lower)
	);
}

function getComposeElements() {
	const root = getComposeRoot();
	return {
		courseControl:
			firstMatch(
				[
					"input#Select___2",
					"input[data-testid='course-select-modal']",
					"input[placeholder*='course' i][role='combobox']",
					"[role='combobox'][data-testid*='course' i]",
					"select[name*='course' i]",
					"select[id*='course' i]",
					"[role='combobox'][aria-label*='course' i]",
				],
				root,
			) || null,
		recipient:
			firstMatch(
				[
					"input[aria-label*='recipient' i]",
					"input[placeholder*='recipient' i]",
					"input[aria-label*='to' i]",
					"input[placeholder='To']",
					"input[role='combobox']",
					"[role='combobox'] input",
				],
				root,
			) || null,
		subject:
			firstMatch(
				["input[aria-label*='subject' i]", "input[name*='subject' i]", "input[placeholder*='subject' i]"],
				root,
			) || null,
		body:
			firstMatch(
				[
					"textarea[aria-label*='message' i]",
					"textarea[placeholder*='message' i]",
					"textarea",
					"[role='textbox'][contenteditable='true']",
					"[contenteditable='true']",
				],
				root,
			) || null,
		sendButton:
			findVisibleButtonByText(/\bsend\b/i, root) || firstMatch(["button[data-testid*='send' i]"], root),
		cancelButton:
			findVisibleButtonByText(/\b(cancel|discard)\b/i, root) ||
			firstMatch(["button[data-testid*='close' i]", "button[aria-label*='close' i]"], root),
	};
}

function wantsOptionList(text) {
	const u = String(text || "").toLowerCase();
	return /\b(list|show|read|tell)\b.*\b(options?|choices?|courses?)\b/.test(u) || /\bwhat are my options\b/.test(u);
}

function normalizeChoiceText(s) {
	return String(s || "")
		.toLowerCase()
		.replace(/[^a-z0-9 ]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function normalizeCourseLabelText(s) {
	return normalizeChoiceText(
		String(s || "")
			.replace(/\bin\s+favorite\s+courses\b/gi, "")
			.replace(/\bfavorite\s+courses\b/gi, "")
			.replace(/\bgroups\b/gi, ""),
	);
}

function cleanCourseLabelForSpeech(s) {
	return String(s || "")
		.replace(/\bin\s+favorite\s+courses\b/gi, "")
		.replace(/\bin\s+groups\b/gi, "")
		.replace(/\bfavorite\s+courses\b/gi, "")
		.replace(/\bgroups\b/gi, "")
		.replace(/\s+/g, " ")
		.trim();
}

function selectOptionsData(sel) {
	if (!sel || sel.tagName !== "SELECT") return [];
	return Array.from(sel.options || [])
		.map((o) => ({ value: o.value, label: (o.textContent || "").trim(), el: o }))
		.filter((o) => o.label && !/^select\b/i.test(o.label));
}

function visiblePopupItems() {
	const roots = [
		...Array.from(document.querySelectorAll("[role='listbox']")).filter(isVisible),
		...Array.from(document.querySelectorAll("[role='menu']")).filter(isVisible),
		...Array.from(document.querySelectorAll(".ui-select-menu, .ui-menu, .ui-popup-content")).filter(isVisible),
	];
	const out = [];
	for (const r of roots.length ? roots : [getComposeRoot()]) {
		const els = [
			...r.querySelectorAll("[role='option']"),
			...r.querySelectorAll("[role='menuitem']"),
			...r.querySelectorAll("li"),
			...r.querySelectorAll("[data-testid*='option' i]"),
		];
		for (const el of els) {
			if (!isVisible(el)) continue;
			const label = (el.textContent || "").trim().replace(/\s+/g, " ");
			if (!label) continue;
			out.push({ el, label });
		}
	}
	return out;
}

function isCourseLikeText(text) {
	return /\b(?:csce|cse|csc|math|engl|hist|phys|chem|bio|course|capstone)\b/i.test(String(text || ""));
}

function getSelectCandidates(root) {
	const merged = [...root.querySelectorAll("select"), ...document.querySelectorAll("select")];
	return Array.from(new Set(merged)).filter((sel) => {
		const optionCount = Array.from(sel.options || []).filter((o) => String(o.textContent || "").trim()).length;
		return isVisible(sel) || optionCount > 1;
	});
}

function scoreCourseSelectCandidate(sel) {
	if (!sel) return 0;
	const idName = `${sel.id || ""} ${sel.name || ""} ${sel.getAttribute?.("aria-label") || ""}`.toLowerCase();
	const options = Array.from(sel.options || []);
	let score = 0;
	const nonEmptyOptions = options.filter((o) => String(o.textContent || "").trim());

	if (nonEmptyOptions.length <= 1) score -= 20;
	if (isVisible(sel)) score += 2;

	if (/\bcourse\b/.test(idName)) score += 5;
	if (nonEmptyOptions.length >= 3) score += 3;

	for (const o of options) {
		const text = String(o.textContent || "").trim();
		const combo = `${text} ${o.value || ""}`.toLowerCase();
		if (combo.includes("course_")) score += 4;
		if (/\bcourse\b/.test(combo)) score += 2;
		if (/[a-z]{2,5}\s*\d{3,4}/i.test(text)) score += 2;
		if (isCourseLikeText(text)) score += 1;
	}

	return score;
}

function speakLabelForCourse(label) {
	return String(label || "")
		.replace(/\bin\s+favorite\s+courses\b/gi, "")
		.replace(/\bfavorite\s+courses\b/gi, "")
		.replace(/\bgroups\b/gi, "")
		.replace(/\s+/g, " ")
		.trim();
}

function dedupeOptionsByLabel(options) {
	const seen = new Set();
	const out = [];
	for (const opt of options || []) {
		const key = normalizeCourseLabelText(opt.label);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		out.push({ ...opt, label: cleanCourseLabelForSpeech(opt.label) });
	}
	return out;
}

function optionIdxFromUtterance(utterance, options) {
	const raw = String(utterance || "").toLowerCase().trim();
	const hasChoiceCue = /\b(option|choice|number|pick)\b/.test(raw);
	const justNumeric = /^\d{1,2}$/.test(raw);
	const justOrdinal = /^(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)$/.test(raw);
	const shouldTreatAsIndex = hasChoiceCue || justNumeric || justOrdinal;

	if (!shouldTreatAsIndex) return null;

	const idx = ordinalToIdx(raw);
	if (idx != null && idx >= 0 && idx < options.length) return idx;
	return null;
}

function extractNumberTokens(s) {
	return new Set((String(s || "").match(/\b\d+\b/g) || []).map((x) => x.trim()));
}

function scoreOptionForUtterance(optionLabel, utterance, mode = "generic") {
	const label = mode === "course" ? normalizeCourseLabelText(optionLabel) : normalizeChoiceText(optionLabel);
	const u = mode === "course" ? normalizeCourseLabelText(utterance) : normalizeChoiceText(utterance);
	if (!label || !u) return Number.NEGATIVE_INFINITY;
	if (label === u) return 100;
	let score = 0;
	if (label.includes(u)) score += 10;
	if (u.includes(label) && label.length > 4) score += 5;
	for (const tok of u.split(" ").filter((x) => x.length > 2)) {
		if (label.includes(tok)) score += 3;
	}

	if (mode === "course") {
		const labelNums = extractNumberTokens(label);
		const utterNums = extractNumberTokens(u);
		if (utterNums.size) {
			let matchedAnyNum = false;
			for (const n of utterNums) {
				if (labelNums.has(n)) {
					score += 8;
					matchedAnyNum = true;
				}
			}
			if (!matchedAnyNum) score -= 12;
		}
	}

	return score;
}

function bestOptionByUtterance(options, utterance, mode = "generic") {
	const idx = optionIdxFromUtterance(utterance, options);
	if (idx != null) return options[idx];

	const ranked = (options || [])
		.map((opt) => ({ ...opt, __score: scoreOptionForUtterance(opt.label, utterance, mode) }))
		.sort((a, b) => b.__score - a.__score);

	return ranked[0] && ranked[0].__score > 0 ? ranked[0] : null;
}

async function speakNumberedOptions(prefix, options) {
	if (!options.length) return;
	const maxSpeak = Math.min(options.length, 10);
	const spoken = options
		.slice(0, maxSpeak)
		.map((o, i) => `${i + 1}: ${o.label}`)
		.join(". ");
	await speak(`${prefix} ${spoken}.`, { raw: true, mode: "read" });
}

function getCourseCombobox() {
	const dialog = getComposeDialog();
	if (!dialog) return null;
	return firstMatch(
		[
			"input[data-testid='course-select-modal']",
			"input#Select___2",
			"input[placeholder*='course' i][role='combobox']",
			"[role='combobox'][data-testid*='course' i]",
			"[role='combobox'][aria-label*='course' i]",
		],
		dialog,
	);
}

function openCourseCombobox() {
	const cb = getCourseCombobox();
	if (!cb) return false;
	cb.focus?.();
	cb.click?.();
	cb.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
	cb.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
	cb.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
	cb.dispatchEvent(new KeyboardEvent("keyup", { key: "ArrowDown", bubbles: true }));
	return true;
}

function openComposeCoursePicker() {
	if (openCourseCombobox()) return true;

	const root = getComposeRoot();
	const { courseControl } = getComposeElements();
	if (courseControl) {
		courseControl.focus?.();
		courseControl.click?.();
		courseControl.dispatchEvent?.(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
		courseControl.dispatchEvent?.(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
		return true;
	}

	const directCourseTrigger = Array.from(
		root.querySelectorAll("[role='combobox'], [aria-haspopup='listbox'], button, div, input"),
	)
		.filter(isVisible)
		.find((el) => {
			const t =
				`${el.textContent || ""} ${el.getAttribute?.("aria-label") || ""} ${el.id || ""} ${el.getAttribute?.("name") || ""}`.toLowerCase();
			return t.includes("select course") || t.includes("course");
		});

	if (directCourseTrigger) {
		directCourseTrigger.focus?.();
		directCourseTrigger.click?.();
		directCourseTrigger.dispatchEvent?.(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
		directCourseTrigger.dispatchEvent?.(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
		return true;
	}

	return false;
}

function courseMenuOptions() {
	const filtered = visiblePopupItems().filter((o) => {
		const l = normalizeChoiceText(o.label);
		if (!l) return false;
		if (/^(back|go back|cancel|clear|close|search|type to search|no results|favorite courses|groups|all courses|courses)$/.test(l)) return false;
		return isCourseLikeText(o.label) || /\b[a-z]{2,5}\s*\d{3,4}\b/i.test(o.label) || /\b\d{4}\b/.test(o.label);
	});

	return dedupeOptionsByLabel(filtered);
}

function extractCourseOptionsFromVisibleTextBlocks() {
	const roots = [
		...Array.from(document.querySelectorAll("[role='listbox']")).filter(isVisible),
		...Array.from(document.querySelectorAll("[role='menu']")).filter(isVisible),
		getComposeRoot(),
	].filter(Boolean);

	const rawLines = [];
	for (const root of roots) {
		const text = String(root.innerText || root.textContent || "").trim();
		if (!text) continue;
		for (const line of text.split("\n")) {
			const clean = line.replace(/\s+/g, " ").trim();
			if (!clean) continue;
			rawLines.push(clean);
		}
	}

	const options = rawLines
		.filter((line) => {
			const l = normalizeChoiceText(line);
			if (!l) return false;
			if (
				/^(compose message|course|select course|favorite courses|unt honors college|groups|all courses|cancel|compose|message|inbox|settings|to|subject)$/.test(l)
			) {
				return false;
			}
			if (/^type to search$|^search$|^no results$/.test(l)) return false;
			if (/^[a-z ]+college$/i.test(line)) return false;
			if (line.length < 2 || line.length > 80) return false;
			return true;
		})
		.map((label) => ({ label }));

	return dedupeOptionsByLabel(options);
}

function getComposeCourseOptions() {
	const { courseControl } = getComposeElements();
	const selects = getSelectCandidates(getComposeRoot());
	const bestSelect =
		selects
			.map((sel) => ({ sel, score: scoreCourseSelectCandidate(sel) }))
			.sort((a, b) => b.score - a.score)
			.find((x) => x.score >= 4 && Array.from(x.sel.options || []).filter((o) => String(o.textContent || "").trim()).length > 1)?.sel || courseControl;

	const selectOptions = dedupeOptionsByLabel(selectOptionsData(bestSelect));
	const popupOptions = courseMenuOptions();
	if (popupOptions.length > 1) return popupOptions;

	const textBlockOptions = extractCourseOptionsFromVisibleTextBlocks();
	if (textBlockOptions.length > 1) return textBlockOptions;

	if (selectOptions.length > 1) return selectOptions;
	if (textBlockOptions.length) return textBlockOptions;
	if (popupOptions.length) return popupOptions;

	return selectOptions;
}

async function applyComposeCourseChoice(choice) {
	const { courseControl } = getComposeElements();
	if (!choice) return false;
	const wanted = normalizeCourseLabelText(choice.label);

	if (courseControl?.tagName === "SELECT" && choice.value) {
		courseControl.value = choice.value;
		courseControl.dispatchEvent(new Event("change", { bubbles: true }));
		return true;
	}

	const selects = getSelectCandidates(getComposeRoot());
	const bestSelect =
		selects
			.map((sel) => ({ sel, score: scoreCourseSelectCandidate(sel) }))
			.sort((a, b) => b.score - a.score)
			.find((x) => x.score >= 4)?.sel || null;

	if (bestSelect?.tagName === "SELECT") {
		const match = Array.from(bestSelect.options || []).find((o) => normalizeCourseLabelText(o.textContent || "") === normalizeCourseLabelText(choice.label));
		if (match) {
			bestSelect.value = match.value;
			bestSelect.dispatchEvent(new Event("change", { bubbles: true }));
			return true;
		}
	}

	if (choice.el) {
		choice.el.dispatchEvent?.(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
		choice.el.click?.();
		choice.el.dispatchEvent?.(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
		return true;
	}

	const popupMatch = visiblePopupItems().find((opt) => normalizeCourseLabelText(opt.label) === wanted);
	if (popupMatch?.el) {
		popupMatch.el.dispatchEvent?.(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
		popupMatch.el.click?.();
		popupMatch.el.dispatchEvent?.(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
		return true;
	}

	const clickableTextMatch = Array.from(getComposeRoot().querySelectorAll("li, div, span, button, [role='option'], [role='menuitem']"))
		.filter(isVisible)
		.find((el) => normalizeCourseLabelText(el.textContent || "") === wanted);
	if (clickableTextMatch) {
		clickableTextMatch.dispatchEvent?.(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
		clickableTextMatch.click?.();
		clickableTextMatch.dispatchEvent?.(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
		return true;
	}

	return false;
}

async function clearComposeWizardState() {
	await mem.set({ composeWizard: null });
}

async function openComposeMessage() {
	if (!isCanvasInboxPage()) {
		await actOpenInbox();
		return { ok: true, message: "Opening inbox first" };
	}

	if (isComposeDialogOpen()) return { ok: true, message: "Compose already open" };

	for (let attempt = 0; attempt < 6; attempt++) {
		const composeBtn =
			findVisibleButtonByText(/\bcompose\b/i) ||
			firstMatch([
				"button[data-testid*='compose' i]",
				"button[aria-label*='compose' i]",
				"[role='button'][aria-label*='compose' i]",
			]);
		if (composeBtn) composeBtn.click?.();
		await delay(220);
		if (isComposeDialogOpen()) return { ok: true, message: "Opened compose" };
	}

	await speak("I couldn't open compose automatically. Please open Inbox and press Compose once.", { mode: "say" });
	return { ok: false, message: "Compose button not found" };
}

async function ensureComposeOpen() {
	if (isComposeDialogOpen()) return true;
	const opened = await openComposeMessage();
	if (!opened?.ok) return false;
	for (let i = 0; i < 8; i++) {
		if (isComposeDialogOpen()) return true;
		await delay(120);
	}
	return false;
}

async function startComposeWizard() {
	const opened = await ensureComposeOpen();
	if (!opened) return { ok: false, message: "Compose unavailable" };

	openComposeCoursePicker();
	await delay(180);
	const courseOptions = getComposeCourseOptions();

	await mem.set({
		composeWizard: {
			active: true,
			step: "course",
			course: "",
			courseOptions,
			recipient: "",
			subject: "",
			body: "",
		},
	});
	await speak("Which course do you want to send the message to? Say list my options if you want me to read them.", {
		mode: "say",
	});
	return { ok: true, message: "Compose wizard started" };
}

async function handleComposeWizardStep(utterance, wizard) {
	const u = String(utterance || "").trim();
	const lower = u.toLowerCase();
	if (!wizard?.active) return null;

	if (/\b(cancel|stop|discard|never mind|nevermind)\b/.test(lower)) {
		const { cancelButton } = getComposeElements();
		cancelButton?.click?.();
		await clearComposeWizardState();
		await speak("Canceled compose message.", { mode: "say" });
		return { ok: true, message: "Compose canceled" };
	}

	const els = getComposeElements();

	if (wizard.step === "course") {
		openComposeCoursePicker();
		await delay(120);
		const options = getComposeCourseOptions();
		wizard.courseOptions = options;
		await mem.set({ composeWizard: wizard });

		if (wantsOptionList(u)) {
			if (options.length) {
				await speakNumberedOptions("Here are your course options.", options);
				return { ok: true, message: "Read course options" };
			}
			await speak("I couldn't read the course options yet. Please open the course dropdown and try again.", {
				mode: "say",
			});
			return { ok: false, message: "Course options unavailable" };
		}

		if (!options.length) {
			await speak("I couldn't find the course options yet. Say list my options, or open the course dropdown and try again.", {
				mode: "say",
			});
			return { ok: false, message: "Course options unavailable" };
		}

		const chosen = bestOptionByUtterance(options, u, "course");
		if (!chosen) {
			await speak("I couldn't match that course. Say the course name, or say list my options.", { mode: "say" });
			return { ok: false, message: "Course not matched" };
		}

		const applied = await applyComposeCourseChoice(chosen);
		if (!applied) {
			await speak("I found the course, but I couldn't select it automatically.", { mode: "say" });
			return { ok: false, message: "Course selection failed" };
		}

		wizard.course = chosen.label;
		wizard.step = "recipient";
		await mem.set({ composeWizard: wizard });
		await speak(`Selected ${chosen.label}. Who is the recipient?`, { mode: "say" });
		return { ok: true, message: "Course set" };
	}

	if (wizard.step === "recipient") {
		if (!writeField(els.recipient, u)) {
			await speak("I couldn't fill the recipient field.", { mode: "say" });
			return { ok: false, message: "Recipient field missing" };
		}
		wizard.recipient = u;
		wizard.step = "subject";
		await mem.set({ composeWizard: wizard });
		await speak("What is the subject line?", { mode: "say" });
		return { ok: true, message: "Recipient set" };
	}

	if (wizard.step === "subject") {
		if (!writeField(els.subject, u)) {
			await speak("I couldn't fill the subject field.", { mode: "say" });
			return { ok: false, message: "Subject field missing" };
		}
		wizard.subject = u;
		wizard.step = "body";
		await mem.set({ composeWizard: wizard });
		await speak("What is the message?", { mode: "say" });
		return { ok: true, message: "Subject set" };
	}

	if (wizard.step === "body") {
		if (!writeField(els.body, u)) {
			await speak("I couldn't fill the message box.", { mode: "say" });
			return { ok: false, message: "Body field missing" };
		}
		wizard.body = u;
		wizard.step = "confirm";
		await mem.set({ composeWizard: wizard });
		await speak("Say send to send it, or cancel.", { mode: "say" });
		return { ok: true, message: "Body set" };
	}

	if (wizard.step === "confirm") {
		if (/\bsend\b/.test(lower)) {
			els.sendButton?.click?.();
			await clearComposeWizardState();
			await speak("Message sent.", { mode: "say" });
			return { ok: true, message: "Message sent" };
		}
		await speak("Say send to send it, or cancel.", { mode: "say" });
		return { ok: false, message: "Awaiting send confirmation" };
	}

	return { ok: false, message: `Unknown compose step: ${wizard.step}` };
}

async function maybeHandleHandsFreeInbox(utterance) {
	const state = await mem.get();
	const wizard = state.composeWizard;
	const u = String(utterance || "").trim();

	if (looksLikeComposeTrigger(u)) {
		await clearComposeWizardState();
		const result = await startComposeWizard();
		return { intent: intents.COMPOSE_MESSAGE, result: { ...result, confidence: 0.98, reason: "compose wizard start" } };
	}

	if (wizard?.active) {
		const result = await handleComposeWizardStep(utterance, wizard);
		return { intent: "COMPOSE_WIZARD_STEP", result: { ...result, confidence: 0.99, reason: "compose wizard active" } };
	}

	return null;
}

async function actComposeMessage(slots = {}) {
	const utterance = slots.utterance || "compose message";
	const handled = await maybeHandleHandsFreeInbox(utterance);
	return handled?.result || { ok: false, message: "Compose wizard not started" };
}

function looksLikeDiscussionTrigger(text) {
	const lower = String(text || "").toLowerCase();
	return /\b(add|create|new|start)\b.*\bdiscussion\b/.test(lower) || /\bdiscussion\b.*\b(add|create|new|start)\b/.test(lower);
}

function parseYesNo(text) {
	const t = String(text || "").toLowerCase();
	if (/\b(yes|yeah|yep|sure|ok|okay|do it|please do)\b/.test(t)) return true;
	if (/\b(no|nope|nah|dont|don’t|do not|stop|not now)\b/.test(t)) return false;
	return null;
}

function findLabelCheckbox(labelPattern) {
	const labels = Array.from(document.querySelectorAll("label"));
	for (const label of labels) {
		const txt = String(label.textContent || "").replace(/\s+/g, " ").trim();
		if (!labelPattern.test(txt)) continue;

		const forId = label.getAttribute("for");
		if (forId) {
			const byId = document.getElementById(forId);
			if (byId?.type === "checkbox") return byId;
		}

		const nested = label.querySelector("input[type='checkbox']");
		if (nested) return nested;

		const wrap = label.closest("li, div, section, fieldset, p") || label.parentElement;
		const near = wrap?.querySelector?.("input[type='checkbox']");
		if (near) return near;
	}

	const wrappers = Array.from(document.querySelectorAll("li, div, section, fieldset, p"));
	for (const w of wrappers) {
		const txt = String(w.textContent || "").replace(/\s+/g, " ").trim();
		if (!labelPattern.test(txt)) continue;
		const cb = w.querySelector("input[type='checkbox']");
		if (cb) return cb;
	}
	return null;
}

function setCheckboxValue(cb, wantChecked) {
	if (!cb) return false;
	const desired = !!wantChecked;
	if (cb.checked === desired) return true;

	try {
		let label = null;
		const id = String(cb.id || "");
		if (id) {
			try {
				label = document.querySelector(`label[for='${CSS.escape(id)}']`);
			} catch {
				label = null;
			}
		}
		if (!label) label = cb.closest("label");
		if (label) label.click();
		else cb.click();
	} catch {}

	if (cb.checked !== desired) {
		try {
			const proto = Object.getPrototypeOf(cb) || HTMLInputElement.prototype;
			const desc =
				Object.getOwnPropertyDescriptor(proto, "checked") ||
				Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked");
			desc?.set?.call(cb, desired);
		} catch {
			cb.checked = desired;
		}
	}

	cb.dispatchEvent(new Event("input", { bubbles: true }));
	cb.dispatchEvent(new Event("change", { bubbles: true }));
	return cb.checked === desired;
}

function isDiscussionNewPage() {
	return /\/discussion_topics\/new\b/i.test(window.location.pathname) || !!firstMatch(["input#discussion_title", "input[name='title']"]);
}

function getDiscussionTitleInput() {
	return firstMatch(["input#discussion_title", "input[name='title']", "input[placeholder*='topic title' i]"]) || null;
}

function getDiscussionContentEditable() {
	return (
		firstMatch(
			[
				"[aria-label*='topic content' i] [contenteditable='true']",
				"[data-testid*='discussion' i] [contenteditable='true']",
				"[role='textbox'][contenteditable='true']",
				"div[contenteditable='true']",
				"textarea[name='message']",
				"textarea#discussion_message",
			],
		) || null
	);
}

function writeDiscussionContent(text) {
	const value = String(text || "").trim();
	if (!value) return false;

	const frame = firstMatch(
		["iframe.tox-edit-area__iframe", "iframe[id$='_ifr']", "iframe[title*='Rich Text' i]"],
		document,
	);

	if (frame) {
		try {
			const doc = frame.contentDocument || frame.contentWindow?.document;
			if (doc?.body) {
				doc.body.focus();
				doc.body.innerHTML = `<p>${value.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c])}</p>`;
				doc.body.dispatchEvent(new Event("input", { bubbles: true }));
				doc.body.dispatchEvent(new Event("change", { bubbles: true }));
				return true;
			}
		} catch (e) {
			console.warn("discussion iframe write failed:", e);
		}
	}

	return writeField(getDiscussionContentEditable(), value);
}

function getDiscussionRequireInitialPostCheckbox() {
	return (
		firstMatch(
			[
				"input[type='checkbox']#discussion_require_initial_post",
				"input[type='checkbox'][name='discussion[require_initial_post]']",
				"input[type='checkbox'][name*='require_initial_post' i]",
				"input[type='checkbox'][id*='require_initial_post' i]",
				"input[type='checkbox'][aria-label*='respond' i]",
				"input[type='checkbox'][aria-label*='other replies' i]",
			],
			document,
		) || null
	);
}

function getDiscussionAllowLikingCheckbox() {
	return (
		firstMatch(
			[
				"input[type='checkbox']#discussion_allow_liking",
				"input[type='checkbox'][name='discussion[allow_liking]']",
				"input[type='checkbox'][name*='allow_liking' i]",
				"input[type='checkbox'][id*='allow_liking' i]",
				"input[type='checkbox'][aria-label*='allow liking' i]",
				"input[type='checkbox'][aria-label*='liking' i]",
			],
			document,
		) || null
	);
}

function findDiscussionSubmitButton() {
	return findVisibleButtonByText(/\b(submit|save|add discussion|save and publish|post to discussion)\b/i) || null;
}

function getDiscussionAutosaveDialog() {
	return (
		Array.from(document.querySelectorAll("[role='dialog'], .ui-dialog, .ReactModal__Content"))
			.filter(isVisible)
			.find((el) => /auto-saved content|autosaved content|load the auto-saved content/i.test(String(el.textContent || ""))) || null
	);
}

function hasDiscussionAutosaveDialog() {
	return !!getDiscussionAutosaveDialog();
}

function clickDiscussionAutosaveChoice(loadSaved) {
	const dialog = getDiscussionAutosaveDialog();
	if (!dialog) return false;
	const re = loadSaved ? /^\s*yes\s*$/i : /^\s*no\s*$/i;
	const btn =
		Array.from(dialog.querySelectorAll("button, [role='button']")).find((el) => isVisible(el) && re.test(String(el.textContent || "").trim())) ||
		null;
	if (!btn) return false;
	btn.click?.();
	return true;
}

async function openDiscussionComposer() {
	if (isDiscussionNewPage()) return true;
	const add = findVisibleButtonByText(/\badd discussion\b/i) || firstMatch(["a[href*='/discussion_topics/new']"]);
	if (add) {
		add.click?.();
		await delay(300);
	}
	for (let i = 0; i < 20; i++) {
		if (isDiscussionNewPage()) return true;
		await delay(150);
	}
	return false;
}

async function clearDiscussionWizardState() {
	await mem.set({ discussionWizard: null });
}

async function startDiscussionWizard() {
	const opened = await openDiscussionComposer();
	if (!opened) {
		await speak("I couldn't open the discussion form.", { mode: "say" });
		return { ok: false, message: "Discussion form unavailable" };
	}

	await mem.set({
		discussionWizard: {
			active: true,
			step: hasDiscussionAutosaveDialog() ? "autosave_prompt" : "title",
			title: "",
			content: "",
			respondBeforeReplies: null,
			allowLiking: null,
		},
	});
	if (hasDiscussionAutosaveDialog()) {
		await speak("I found auto saved content. Would you like to load the auto saved content instead? Say yes or no.", { mode: "say" });
		return { ok: true, message: "Discussion autosave prompt started" };
	}
	await speak("What would you want as a topic title?", { mode: "say" });
	return { ok: true, message: "Discussion wizard started" };
}

async function handleDiscussionWizardStep(utterance, wizard) {
	const u = String(utterance || "").trim();
	const lower = u.toLowerCase();
	if (!wizard?.active) return null;

	if (/\b(cancel|stop|discard|never mind|nevermind)\b/.test(lower)) {
		await clearDiscussionWizardState();
		await speak("Canceled add discussion.", { mode: "say" });
		return { ok: true, message: "Discussion canceled" };
	}

	if (wizard.step === "autosave_prompt") {
		const yn = parseYesNo(u);
		if (yn == null) {
			await speak("Please say yes or no for the auto saved content.", { mode: "say" });
			return { ok: false, message: "Expected yes or no for autosave prompt" };
		}
		if (!clickDiscussionAutosaveChoice(yn)) {
			await speak("I couldn't answer the auto saved content prompt automatically.", { mode: "say" });
			return { ok: false, message: "Autosave prompt buttons not found" };
		}
		await delay(350);
		wizard.step = "title";
		await mem.set({ discussionWizard: wizard });
		await speak("What would you want as a topic title?", { mode: "say" });
		return { ok: true, message: "Autosave prompt handled" };
	}

	if (wizard.step === "title") {
		if (!writeField(getDiscussionTitleInput(), u)) {
			await speak("I couldn't fill the discussion title.", { mode: "say" });
			return { ok: false, message: "Discussion title field missing" };
		}
		wizard.title = u;
		wizard.step = "content";
		await mem.set({ discussionWizard: wizard });
		await speak("Please speak out the topic content.", { mode: "say" });
		return { ok: true, message: "Discussion title set" };
	}

	if (wizard.step === "content") {
		if (!writeDiscussionContent(u)) {
			await speak("I couldn't fill the discussion content editor.", { mode: "say" });
			return { ok: false, message: "Discussion content field missing" };
		}
		wizard.content = u;
		wizard.step = "require_before_reply";
		await mem.set({ discussionWizard: wizard });
		await speak("Participants must respond to the topic before viewing other replies. Do you want this option? Say yes or no.", { mode: "say" });
		return { ok: true, message: "Discussion content set" };
	}

	if (wizard.step === "require_before_reply") {
		const yn = parseYesNo(u);
		if (yn == null) {
			await speak("Please say yes or no for the participants must respond option.", { mode: "say" });
			return { ok: false, message: "Expected yes or no for participants option" };
		}

		const cb =
			getDiscussionRequireInitialPostCheckbox() ||
			findLabelCheckbox(/participants must respond to the topic before viewing other replies/i) ||
			findLabelCheckbox(/respond.*before.*repl/i) ||
			findLabelCheckbox(/viewing other replies/i);
		if (!cb || !setCheckboxValue(cb, yn)) {
			await speak("I could not set that option automatically.", { mode: "say" });
			return { ok: false, message: "Participants option checkbox not found" };
		}

		wizard.respondBeforeReplies = yn;
		wizard.step = "allow_liking";
		await mem.set({ discussionWizard: wizard });
		await speak("Allow liking. Do you want this option? Say yes or no.", { mode: "say" });
		return { ok: true, message: "Participants option set" };
	}

	if (wizard.step === "allow_liking") {
		const yn = parseYesNo(u);
		if (yn == null) {
			await speak("Please say yes or no for allow liking.", { mode: "say" });
			return { ok: false, message: "Expected yes or no for allow liking" };
		}

		const cb =
			getDiscussionAllowLikingCheckbox() ||
			findLabelCheckbox(/allow liking/i) ||
			findLabelCheckbox(/\bliking\b/i);
		if (!cb || !setCheckboxValue(cb, yn)) {
			await speak("I could not set allow liking automatically.", { mode: "say" });
			return { ok: false, message: "Allow liking checkbox not found" };
		}

		wizard.allowLiking = yn;
		wizard.step = "confirm_submit";
		await mem.set({ discussionWizard: wizard });
		await speak("Would you like to submit? Say yes or no.", { mode: "say" });
		return { ok: true, message: "Allow liking set" };
	}

	if (wizard.step === "confirm_submit") {
		const yn = parseYesNo(u);
		if (yn == null) {
			await speak("Please say yes to submit or no to cancel.", { mode: "say" });
			return { ok: false, message: "Expected yes or no for submit confirmation" };
		}
		if (yn) {
			findDiscussionSubmitButton()?.click?.();
			await clearDiscussionWizardState();
			await speak("Discussion submitted.", { mode: "say" });
			return { ok: true, message: "Discussion submitted" };
		}
		await clearDiscussionWizardState();
		await speak("Okay, I did not submit.", { mode: "say" });
		return { ok: true, message: "Discussion submit canceled" };
	}

	return { ok: false, message: `Unknown discussion step: ${wizard.step}` };
}

async function maybeHandleDiscussionWizard(utterance) {
	const state = await mem.get();
	const wizard = state.discussionWizard;
	const u = String(utterance || "").trim();

	if (looksLikeDiscussionTrigger(u)) {
		await clearDiscussionWizardState();
		const result = await startDiscussionWizard();
		return { intent: intents.ADD_DISCUSSION, result: { ...result, confidence: 0.98, reason: "discussion wizard start" } };
	}

	if (wizard?.active) {
		const result = await handleDiscussionWizardStep(utterance, wizard);
		return { intent: "DISCUSSION_WIZARD_STEP", result: { ...result, confidence: 0.99, reason: "discussion wizard active" } };
	}

	return null;
}

async function actAddDiscussion(slots = {}) {
	const utterance = slots.utterance || "add discussion";
	const handled = await maybeHandleDiscussionWizard(utterance);
	return handled?.result || { ok: false, message: "Discussion wizard not started" };
}

// =============================================================================
// 18) Router
// =============================================================================

export async function runAction(intent, slots = {}) {
	switch (intent) {
		case "OPEN_INBOX":
			return await actOpenInbox();
		case "COMPOSE_MESSAGE":
			return await actComposeMessage();
		case intents.LOG_IN:
			return await actLogIn(slots);
		case intents.OPEN_SETTINGS:
			return await actOpenSettings();

		case intents.OPEN_GRADES:
			return await actOpenGrades();
		case intents.OPEN_ASSIGNMENTS:
			return await actOpenAssignments();
		case intents.OPEN_MODULES:
			return await actOpenModules();
		case intents.OPEN_QUIZZES:
			return await actOpenQuizzes();
		case intents.OPEN_FILES:
			return await actOpenFiles();
		case intents.OPEN_INBOX:
			return await actOpenInbox();

		case intents.OPEN_COURSES:
			return await actOpenCourses();

		case intents.OPEN_DASHBOARD:
			return await actOpenDashboard();
		case intents.GO_BACK:
			return await actGoBack();

		case intents.SMALL_TALK:
			return await actSmallTalk(slots.utterance ?? "");

		case intents.OPEN_COURSE_BY_NUMBER:
			return await actOpenCourseByQuery(`open ${slots.courseNum || ""}`);

		case intents.OPEN_ASSIGNMENT_QUERY:
			return await actOpenAssignmentQuery(slots.q);

		case intents.CHOOSE_OPTION:
			return await actChooseOption(slots.idx);

		case intents.NAVIGATE_TO:
			return await actNavigateTo(slots.target);

		case intents.READ_PAGE:
			return await actReadPage();
		case intents.SUMMARIZE_PAGE:
			return await actSummarizePage();
		case intents.READ_RECENT_MESSAGE:
			return await actReadRecentMessage();
		case intents.READ_NEXT:
			return await actReadNext();
		case intents.REPEAT:
			return await actRepeat();
		case intents.HELP:
			return await actHelp();

		case intents.AFFIRM:
			return await actAffirmDeny(true);
		case intents.DENY:
			return await actAffirmDeny(false);

		case intents.COMPOSE_MESSAGE:
			return await actComposeMessage(slots);
		case intents.ADD_DISCUSSION:
			return await actAddDiscussion(slots);

		case "OPEN_ASSIGNMENTS_FOR_COURSE":
			return await actOpenAssignmentsForCourse(slots.courseNum);

		case INTERNAL_INTENTS.OPEN_ASSIGNMENT_DUE_IN:
			return await actOpenAssignmentDueIn(slots.md);

		case intents.DUE_TODAY:
			return await actDueToday(slots);
		case intents.DUE_THIS_WEEK:
			return await actDueThisWeek(slots);

		case intents.NEXT_DUE:
			return await actNextDue();
		case intents.OVERDUE:
			return await actOverdue();
		case intents.QA_GENERAL:
			return await actGeneralQA(slots.utterance ?? "");
		case intents.OPEN_HOME:
			return await actOpenDashboard();

		default:
			await speak("I missed that. Try: dashboard, courses, assignments, grades, or back.", { mode: "say" });
			await remember({
				expectingYesNo: false,
				pendingAction: null,
				lastIntent: intents.UNKNOWN,
				expectingChoice: false,
				choiceOptions: null,
			});
			return { ok: false, message: "Unknown intent; asked clarification" };
	}
}

// =============================================================================
// 19) Resume queued steps on page load
// =============================================================================

let __resumeQueueRunning = false;
let __lastQueueResumeAt = 0;
export async function resumePendingQueue() {
  const now = Date.now();
  if (now - __lastQueueResumeAt < 800) {
    return { ok: true, message: "Queue resume cooldown" };
  }
  __lastQueueResumeAt = now;

  if (__resumeQueueRunning) return { ok: true, message: "Queue already running (mutex)" };
  __resumeQueueRunning = true;

  try {
    const st = await mem.get();

    // prevent "ghost" resumes right after manual navigation (like back)
    if (isAutoResumeSuppressed(st)) {
      return { ok: true, message: "Resume suppressed" };
    }

    // ✅ Prefer Memory queue, but fall back to sessionStorage resume queue
    let q = Array.isArray(st.pendingQueue) ? st.pendingQueue : null;

    if (!q || !q.length) {
      const saved = __CONVOX.actions.loadResumeQueue();
      if (saved?.queue?.length) {
        q = saved.queue;

        // Re-hydrate Memory so the rest of code can operate normally
        await mem.set({
          pendingQueue: q,
          pendingQueueMeta: saved.meta || { createdAt: Date.now(), kind: "rehydrated" },
        });
      }
    }

    if (!q || !q.length) {
      __CONVOX.actions.clearResumeQueue();
      return { ok: true, message: "No queue" };
    }

    const step = q[0];
    if (!step?.intent) {
      await clearQueue();
      return { ok: false, message: "Bad queue step" };
    }

    await delay(250);

    // INTERNAL intent support
    if (step.intent === INTERNAL_INTENTS.OPEN_ASSIGNMENT_DUE_IN) {
      const res = await actOpenAssignmentDueIn(step.slots?.md);
      if (res?.ok) await shiftQueue();
      return res;
    }

    const isNav = NAV_INTENTS.has(step.intent);

    if (isNav) {
      // ✅ Pre-advance before navigation (prevents repeating forever)
      await shiftQueue();
      await delay(50);
      return await runAction(step.intent, step.slots || {});
    }

    const res = await runAction(step.intent, step.slots || {});
    if (res?.ok) await shiftQueue();
    return res;
  } finally {
    __resumeQueueRunning = false;
  }
}


// =============================================================================
// 20) Auto-resume hooks (Canvas SPA safe)
// =============================================================================
let _autoResumeInstalled = false;
if (!__CONVOX.actions.initAutoResume) {
  __CONVOX.actions.initAutoResume = function initAutoResume() {
    if (__CONVOX.actions.autoResumeInstalled) return;
    __CONVOX.actions.autoResumeInstalled = true;

    const fire = () => {
      clearTimeout(window.__convoxResumeTimer);
      window.__convoxResumeTimer = setTimeout(() => {
		try { resumePlanIfAny(); } catch (e) { console.warn("resumePlanIfAny failed:", e); }
		try { resumePendingQueue(); } catch (e) { console.warn("resumePendingQueue failed:", e); }
		try { resumePendingAnnouncementRead(); } catch (e) { console.warn("resumePendingAnnouncementRead failed:", e); }

      }, 250);
    };

    window.addEventListener("beforeunload", () => {
      try { sessionStorage.removeItem("__convox_plan_mutex_v1"); } catch {}
    });

    if (document.readyState === "complete" || document.readyState === "interactive") fire();
    window.addEventListener("load", fire);
    document.addEventListener("DOMContentLoaded", fire);

    document.addEventListener("turbo:load", fire);
    document.addEventListener("turbolinks:load", fire);

    const origPush = history.pushState;
    const origReplace = history.replaceState;

    history.pushState = function (...args) {
      const r = origPush.apply(this, args);
      window.dispatchEvent(new Event("convox:urlchange"));
      return r;
    };

    history.replaceState = function (...args) {
      const r = origReplace.apply(this, args);
      window.dispatchEvent(new Event("convox:urlchange"));
      return r;
    };

    window.addEventListener("popstate", () =>
      window.dispatchEvent(new Event("convox:urlchange"))
    );
    window.addEventListener("convox:urlchange", fire);

    const mo = new MutationObserver(() => fire());
    const root = document.querySelector("#application, #content, main, body");
    if (root) mo.observe(root, { childList: true, subtree: true });
  };
}

export const initAutoResume = __CONVOX.actions.initAutoResume;

// =============================================================================
// 21) Chained command helpers
// =============================================================================

async function ensureNavigationOrHardRedirect(targetHref, { waitMs = 900 } = {}) {
  const before = location.href;

  // wait briefly to see if Canvas SPA updates the URL
  const changed = await __CONVOX.actions.waitForUrlChange(before, waitMs);

  // if still not changed, hard redirect (fixes "pending click" that fires later)
  if (!changed) {
    window.location.href = targetHref;
    return false;
  }
  return true;
}


function hardCancelResumes() {
  try { __CONVOX.actions?.clearResumePlan?.(); } catch {}
  try { sessionStorage.removeItem("__convox_plan_resume_v1"); } catch {}
  try { sessionStorage.removeItem("__convox_plan_mutex_v1"); } catch {}
  try { sessionStorage.removeItem("convox_manual_nav_ts"); } catch {}
  try { __CONVOX.actions?.clearResumeQueue?.(); } catch {}
  try { sessionStorage.removeItem("__convox_queue_resume_v1"); } catch {}

}

function splitChainedCommands(text) {
	const t = String(text || "").trim();
	if (!t) return [];

	const hard = t
		.split(/\b(?:and then|then|after that|afterwards|next)\b/gi)
		.map((s) => s.trim())
		.filter(Boolean);

	if (hard.length >= 2) return hard;

	const m = t.match(/^(.*)\b and \b(.*)$/i);
	if (!m) return [t];

	const left = (m[1] || "").trim();
	const right = (m[2] || "").trim();

	const rhsLooksCommand =
		/^(open|go to|navigate|read|help|repeat|back|submit)\b/i.test(right) ||
		/\b(dashboard|courses|assignments|grades|modules|quizzes|files|home)\b/i.test(right);

	if (!rhsLooksCommand) return [t];

	return [left, right].filter(Boolean);
}

function forceCommandVerb(chunk) {
	const c = String(chunk || "").trim();
	if (!c) return "";
	if (/^(open|go to|navigate|read|help|repeat|back|go back|submit)\b/i.test(c)) return c;
	if (/^(assignments?|grades?|courses?|modules?|quizzes?|files?|dashboard|home)\b/i.test(c)) return `open ${c}`;
	return c;
}

async function buildPlanStepsFromChunks(chunks, detector, context) {
	const steps = [];

	const fastIntentFromChunk = (cmd) => {
		const c = normalizeASR(cmd).toLowerCase().trim();

		// back
		if (/\b(go back|back)\b/.test(c)) return { intent: intents.GO_BACK, slots: {} };
		// inside buildPlanStepsFromChunks() -> fastIntentFromChunk

		// dashboard/home
		if (/\bdashboard\b/.test(c)) return { intent: intents.OPEN_DASHBOARD, slots: {} };
		if (/\bhome\b/.test(c)) return { intent: intents.OPEN_HOME, slots: {} };

		// ALSO treat "go dashboard" / "go to dashboard" as dashboard
		if (/\bgo\s+(to\s+)?(dashboard|home)\b/.test(c)) return { intent: intents.OPEN_DASHBOARD, slots: {} };

		// courses
		if (/\bopen\s+(courses|course list|all courses)\b/.test(c) || c === "courses") {
			return { intent: intents.OPEN_COURSES, slots: {} };
		}

		// assignments
		if (/\b(assignments?|homework|to do|to-do|tasks)\b/.test(c) && /\bopen\b/.test(c)) {
			return { intent: intents.OPEN_ASSIGNMENTS, slots: {} };
		}

		// grades
		if (/\bgrades?\b/.test(c) && /\bopen\b/.test(c)) {
			return { intent: intents.OPEN_GRADES, slots: {} };
		}

		// modules / quizzes / files
		if (/\bmodules?\b/.test(c) && /\bopen\b/.test(c)) return { intent: intents.OPEN_MODULES, slots: {} };
		if (/\bquizzes?\b/.test(c) && /\bopen\b/.test(c)) return { intent: intents.OPEN_QUIZZES, slots: {} };
		if (/\bfiles?\b/.test(c) && /\bopen\b/.test(c)) return { intent: intents.OPEN_FILES, slots: {} };

		// course-by-number (your existing robust parser)
		const q = parseCourseQueryFromUtterance(c.startsWith("open ") ? c : `open ${c}`);
		if (q && (q.dept || q.num)) {
			return { intent: intents.OPEN_COURSE_BY_NUMBER, slots: { courseNum: q.num || q.remainder } };
		}

		return null;
	};

	for (const raw of chunks) {
		const cmd = forceCommandVerb(raw);
		if (!cmd) continue;

		// deterministic first
		const fast = fastIntentFromChunk(cmd);
		if (fast) {
			steps.push(fast);
			continue;
		}

		// fallback to detector
		const det = await detector(cmd, context);
		const intent = det?.intent || intents.UNKNOWN;
		const confidence = typeof det?.confidence === "number" ? det.confidence : 0;

		if (intent !== intents.UNKNOWN && confidence >= 0.55) {
			steps.push({ intent, slots: det?.slots || {} });
		}
	}

	return steps;
}


function parseCourseRef(text = "") {
  // supports: "course 5210", "csce 5210", "cse 5210", "psci 2306", etc.
  const t = String(text || "").toLowerCase();

  // try dept+num first
  const m1 = t.match(/\b(csce|cse|csc|cs|psci|math|engl|hist|biol|chem|phys)\s*(\d{3,4})\b/i);
  if (m1) return { dept: m1[1], num: m1[2], raw: `${m1[1]} ${m1[2]}` };

  // try just number
  const m2 = t.match(/\b(\d{4})\b/);
  if (m2) return { dept: null, num: m2[1], raw: m2[1] };

  return null;
}

function parseTargetSection(text = "") {
  const t = String(text || "").toLowerCase();

  if (/\bassignments?\b|\bhomework\b|\bto\s*do\b/.test(t)) return { section: "assignments" };
  if (/\bgrades?\b|\bgrade\b/.test(t)) return { section: "grades" };
  if (/\bmodules?\b/.test(t)) return { section: "modules" };
  if (/\bquizzes?\b/.test(t)) return { section: "quizzes" };
  if (/\bfiles?\b/.test(t)) return { section: "files" };

  return null;
}

function parseSpecificItem(text = "") {
  // module name/number, assignment name/number, hw #
  const t = String(text || "").trim();

  // HW / Assignment number
  const hw = t.match(/\b(hw|homework|assignment)\s*(\d+)\b/i);
  if (hw) return { kind: "assignment", q: `HW ${hw[2]}` };

  // "module 3" or "module introduction"
  const mod = t.match(/\bmodule\s+(.+?)$/i);
  if (mod) return { kind: "module", q: `module ${mod[1].trim()}` };

  // "assignment project 1"
  const asg = t.match(/\bassignment\s+(.+?)$/i);
  if (asg) return { kind: "assignment", q: `assignment ${asg[1].trim()}` };

  return null;
}

/**
 * Expand natural phrases like:
 * - "open assignments from course csce 5210"
 * - "open grades from course 5210"
 * - "from course csce 3214 open modules"
 * - "open module 3 from course 3530"
 * - "from course 3530 open assignment hw 2"
 *
 * Returns array of chunk strings, in execution order.
 */
function expandCourseScopedCommand(cleaned = "") {
  const u = String(cleaned || "").trim();
  const low = u.toLowerCase();

  // normalize tiny ASR issues you see in logs: "coors", "corps", "coir"
  const fixed = low
    .replace(/\bcoors\b/g, "course")
    .replace(/\bcorps\b/g, "course")
    .replace(/\bcoir\b/g, "course")
    .replace(/\bcore\b/g, "course");

  // Pattern A: "open <thing> from course <X>"
  // Pattern B: "from course <X> open <thing>"
	let m =
	fixed.match(/\bopen\s+(.+?)\s+(from|in)\s+course\s+(.+)\b/i) ||
	fixed.match(/\b(from|in)\s+course\s+(.+?)\s+open\s+(.+)\b/i);


  if (!m) return null;

  let thingPart, coursePart;
  if (fixed.startsWith("from course")) {
    coursePart = m[1];
    thingPart = m[2];
  } else {
    thingPart = m[1];
    coursePart = m[2];
  }

  const courseRef = parseCourseRef(coursePart);
  if (!courseRef) return null;

  const section = parseTargetSection(thingPart);
  const specific = parseSpecificItem(thingPart);

  const chunks = [];
  // Always start by opening the course
  chunks.push(`open course ${courseRef.raw}`);

  // If the user asked for a section, open it next
  if (section?.section) {
    chunks.push(`open ${section.section}`);
  }

  // If they asked for a specific assignment/module:
  // - If assignment: ensure assignments tab first, then open assignment query
  if (specific?.kind === "assignment") {
    if (!section?.section) chunks.push("open assignments");
    chunks.push(`open ${specific.q}`);
  }

  // For modules: open modules tab then locate module (you’ll implement actOpenModuleQuery later if desired)
  if (specific?.kind === "module") {
    if (!section?.section) chunks.push("open modules");
    chunks.push(`open ${specific.q}`);
  }

  return chunks;
}



// =============================================================================
// 22) Deterministic chunk -> steps (beats detector for navigation)
// =============================================================================

function detectSectionIntentFromText(t) {
	const u = String(t || "").toLowerCase();

	if (/\bgrades?\b/.test(u)) return intents.OPEN_GRADES;
	if (/\bassignments?\b|\bhomework\b|\btasks?\b/.test(u)) return intents.OPEN_ASSIGNMENTS;
	if (/\bmodules?\b/.test(u)) return intents.OPEN_MODULES;
	if (/\bquizzes?\b/.test(u)) return intents.OPEN_QUIZZES;
	if (/\bfiles?\b/.test(u)) return intents.OPEN_FILES;
	if (/\bcourses?\b|\bclasses?\b/.test(u)) return intents.OPEN_COURSES;
	if (/\bdashboard\b|\bhome\b/.test(u)) return intents.OPEN_DASHBOARD;
	if (/\bgo back\b|\bback\b/.test(u)) return intents.GO_BACK;

	return null;
}

// "open grades from course csce 5210" => [open course 5210, open grades]
function parseSectionFromCourseChunk(chunk) {
	const u = String(chunk || "").toLowerCase();
	const hasFrom = /\b(from|in|for)\b/.test(u);
	const sectionIntent = detectSectionIntentFromText(u);
	const courseNum = parseCourseNumberFromText(u);

	if (!sectionIntent || !courseNum) return null;
	if (!hasFrom && !/\bcourse\b/.test(u)) return null;

	let pathNeed = "/courses/";
	if (sectionIntent === intents.OPEN_GRADES) pathNeed = "/grades";
	else if (sectionIntent === intents.OPEN_ASSIGNMENTS) pathNeed = "/assignments";
	else if (sectionIntent === intents.OPEN_MODULES) pathNeed = "/modules";
	else if (sectionIntent === intents.OPEN_QUIZZES) pathNeed = "/quizzes";
	else if (sectionIntent === intents.OPEN_FILES) pathNeed = "/files";
	const ref = parseCourseRef(u); // returns { dept, num } or null
	return [
	{
		intent: intents.OPEN_COURSE_BY_NUMBER,
		slots: { courseNum },
		// ✅ FIX
		until: { type: "COURSE_NUM", value: courseNum },
	},
	{
		intent: sectionIntent,
		slots: {},
		until: { type: "PATH_INCLUDES", value: pathNeed },
	},
	];

}

// "open course 5210" / "open csce 5210" => step
function parseOpenCourseChunk(chunk) {
  const u = String(chunk || "").toLowerCase();
  if (!/\bopen\b/.test(u)) return null;

  const courseNum = parseCourseNumberFromText(u);
  if (!courseNum) return null;

  // treat "open courses" as not a specific course
  if (/\bopen\s+courses?\b/.test(u)) return null;

	return {
	intent: intents.OPEN_COURSE_BY_NUMBER,
	slots: { courseNum },
	until: { type: "COURSE_NUM", value: courseNum }, // ✅
	};

}


// "open grades" / "open assignments" etc => step
function parseOpenSectionChunk(chunk) {
	const u = String(chunk || "").toLowerCase();
	if (!/\bopen\b/.test(u) && !/^(grades?|assignments?|modules?|quizzes?|files?|courses?|dashboard|home)\b/.test(u))
		return null;

	const sec = detectSectionIntentFromText(u);
	if (!sec) return null;

	let pathNeed = null;
	if (sec === intents.OPEN_GRADES) pathNeed = "/grades";
	else if (sec === intents.OPEN_ASSIGNMENTS) pathNeed = "/assignments";
	else if (sec === intents.OPEN_MODULES) pathNeed = "/modules";
	else if (sec === intents.OPEN_QUIZZES) pathNeed = "/quizzes";
	else if (sec === intents.OPEN_FILES) pathNeed = "/files";

	return pathNeed ? { intent: sec, slots: {}, until: { type: "PATH_INCLUDES", value: pathNeed } } : { intent: sec, slots: {} };
}

async function compileChunkToSteps(chunk, detector, context) {
	const c = forceCommandVerb(chunk);

	// highest priority: section-from-course (2 steps)
	const two = parseSectionFromCourseChunk(c);
	if (two) return two;

	// course open
	const courseStep = parseOpenCourseChunk(c);
	if (courseStep) return [courseStep];

	// explicit section open
	const sectionStep = parseOpenSectionChunk(c);
	if (sectionStep) return [sectionStep];

	// fallback to detector for non-nav stuff
	const det = await detector(c, context);
	const intent = det?.intent || intents.UNKNOWN;
	const confidence = typeof det?.confidence === "number" ? det.confidence : 0;
	if (intent === intents.UNKNOWN || confidence < 0.55) return [];
	return [{ intent, slots: det?.slots || {} }];
}

// =============================================================================
// 23) handleUtterance (dynamic chained commands + barriers)
// =============================================================================
export async function handleUtterance(utterance, nluDetect) {
  const detector = nluDetect ?? (await import("./intent.js")).detectIntent;

  // Always define these up front (fixes: "cleaned is not defined", "ctx0 before init")
  const cleaned = normalizeASR(utterance);
  const ctx0 = await mem.get();
  const composeResult = await handleComposeFlow(cleaned);
  if (composeResult) {
    await mem.set({ lastHeard: cleaned, lastIntent: "COMPOSE_FLOW" });
    return { intent: "COMPOSE_FLOW", result: { ...composeResult, confidence: 0.99, reason: "compose-flow" } };
  }

  if (/^\s*(open|go to|show)\s+(my\s+)?(inbox|messages?)\s*$/i.test(cleaned)) {
    const r = await runAction("OPEN_INBOX", {});
    await mem.set({ lastHeard: cleaned, lastIntent: "OPEN_INBOX" });
    return { intent: "OPEN_INBOX", result: { ...r, confidence: 0.98, reason: "rule: openInbox" } };
  }

  if (/\b(compose|write|create|start)\b.*\b(message|inbox message)\b/i.test(cleaned)) {
    const r = await runAction("COMPOSE_MESSAGE", {});
    await mem.set({ lastHeard: cleaned, lastIntent: "COMPOSE_MESSAGE" });
    return { intent: "COMPOSE_MESSAGE", result: { ...r, confidence: 0.98, reason: "rule: composeMessage" } };
  }

  if (isReadRecentMessageCommand(cleaned)) {
    const result = await actReadRecentMessage();
    await mem.set({ lastHeard: cleaned, lastIntent: intents.READ_RECENT_MESSAGE });
    return { intent: intents.READ_RECENT_MESSAGE, result: { ...result, confidence: 0.98, reason: "direct inbox recent message" } };
  }

  const announcementHandled = await maybeHandleAnnouncementAssist(cleaned);
  if (announcementHandled) {
    await mem.set({ lastHeard: cleaned, lastIntent: announcementHandled.intent });
    return announcementHandled;
  }

  const discussionHandled = await maybeHandleDiscussionWizard(cleaned);
  if (discussionHandled) {
    await mem.set({ lastHeard: cleaned, lastIntent: discussionHandled.intent });
    return discussionHandled;
  }

  const composeHandled = await maybeHandleHandsFreeInbox(cleaned);
  if (composeHandled) {
    await mem.set({ lastHeard: cleaned, lastIntent: composeHandled.intent });
    return composeHandled;
  }

  // Continuation = only if we are in an explicit follow-up mode
  const isContinuation = Boolean(
    ctx0?.expectingChoice ||
    ctx0?.expectingYesNo ||
    ctx0?.expectingList ||
    ctx0?.expectingFollowUp ||
    ctx0?.composeFlow?.stage
  );

  // -------------------------------------------------------------------------
  // ✅ Fresh command hygiene (prevents ghost resume + wrong-course section opens)
  // -------------------------------------------------------------------------
  if (!isContinuation) {
    // Stop any “resume” from firing right after this command starts
    await suppressAutoResume(5000);

    // Kill any persisted resume payloads from the plan runner
    try { __CONVOX.actions.clearResumePlan?.(); } catch {}

    // Nuke queue + plan from previous command
    await clearQueue();
    try {
      const st = await mem.get();
      if (st?.plan?.kind === "CHAINED_COMMANDS" || st?.plan?.kind === "SECTION_FROM_COURSE") {
        await clearPlan();
      }
    } catch {}
  }

  // -------------------------------------------------------------------------
  // 23.1) Follow-up handler: due pick (today / this week / courses)
  // -------------------------------------------------------------------------
  if (ctx0?.expectingFollowUp?.kind === "DUE_PICK") {
    const u = String(cleaned || "").toLowerCase().trim();
    if (Date.now() - (ctx0.expectingFollowUp.createdAt || 0) > 30000) {
      await mem.set({ expectingFollowUp: null });
    } else {
      if (/\b(today|due today)\b/.test(u)) {
        await mem.set({ expectingFollowUp: null });
        const r = await runAction(intents.DUE_TODAY, { utterance: cleaned });
        await mem.set({ lastHeard: cleaned, lastIntent: intents.DUE_TODAY });
        return { intent: intents.DUE_TODAY, result: { ...r, confidence: 0.9, reason: "follow-up due today" } };
      }
      if (/\b(this week|week|do this week|due this week)\b/.test(u)) {
        await mem.set({ expectingFollowUp: null });
        const r = await runAction(intents.DUE_THIS_WEEK, { utterance: cleaned });
        await mem.set({ lastHeard: cleaned, lastIntent: intents.DUE_THIS_WEEK });
        return { intent: intents.DUE_THIS_WEEK, result: { ...r, confidence: 0.9, reason: "follow-up due this week" } };
      }
      if (/\b(course|courses|open course|open courses)\b/.test(u)) {
        await mem.set({ expectingFollowUp: null });
        const r = await runAction(intents.OPEN_COURSES, {});
        await mem.set({ lastHeard: cleaned, lastIntent: intents.OPEN_COURSES });
        return { intent: intents.OPEN_COURSES, result: { ...r, confidence: 0.9, reason: "follow-up open courses" } };
      }
    }
  }

  // -------------------------------------------------------------------------
  // 23.2) List follow-up handler (due list: more / next five / full list)
  // -------------------------------------------------------------------------
  if (ctx0?.expectingList?.kind === "DUE_LIST") {
    const u = String(cleaned || "").toLowerCase().trim();
    if (Date.now() - (ctx0.expectingList.createdAt || 0) > 120000) {
      await mem.set({ expectingList: null });
    } else {
      const items = Array.isArray(ctx0.expectingList.items) ? ctx0.expectingList.items : [];
      let cursor = Number(ctx0.expectingList.cursor || 0);

      const sayRange = async (n) => {
        const slice = items.slice(cursor, cursor + n);
        cursor += slice.length;

        if (!slice.length) {
          await speak("That’s all I have.", { mode: "say" });
          await mem.set({ expectingList: null });
          return;
        }

        const spoken = slice
          .map((x) => {
            const dueLabel = x.dueAt ? toLocalDueLabel(x.dueAt).replace(/\s*,?\s*12:00\s*AM\b/i, "") : "";
            return dueLabel ? `${x.title} (due ${dueLabel})` : x.title;
          })
          .join(", ");

        await speak(spoken, { mode: "say" });

        if (cursor < items.length) {
          await mem.set({ expectingList: { ...ctx0.expectingList, cursor } });
        } else {
          await mem.set({ expectingList: null });
        }
      };

      if (/\b(full list|all of them|everything)\b/.test(u)) {
        await sayRange(50);
        return { intent: "LIST_FOLLOWUP", result: { ok: true, message: "Spoke full list", confidence: 0.9 } };
      }
      if (/\b(next five|five more|5 more)\b/.test(u)) {
        await sayRange(5);
        return { intent: "LIST_FOLLOWUP", result: { ok: true, message: "Spoke next five", confidence: 0.9 } };
      }
      if (/\b(more|next|continue)\b/.test(u)) {
        await sayRange(3);
        return { intent: "LIST_FOLLOWUP", result: { ok: true, message: "Spoke more", confidence: 0.9 } };
      }
    }
  }

  // -------------------------------------------------------------------------
  // 23.3) Choice mode handler
  // -------------------------------------------------------------------------
  if (ctx0?.expectingChoice) {
    const u = String(cleaned || "").toLowerCase().trim();

    if (/\b(cancel|nevermind|never mind|stop|exit)\b/i.test(u)) {
      await mem.set({ expectingChoice: false, choiceOptions: null });
      await speak("Canceled.", { mode: "say" });
      return { intent: intents.DENY, result: { ok: true, message: "Canceled choice mode", confidence: 0.99 } };
    }

    if (/\b(repeat|say again|again)\b/i.test(u) && /\b(option|options|choices)\b/i.test(u)) {
      await speakChoiceOptions();
      return { intent: "REPEAT_OPTIONS", result: { ok: true, message: "Repeated options", confidence: 0.99 } };
    }

    const looksLikeNewCommand =
      /^open\b/.test(u) ||
      /\b(dashboard|home|courses|assignments|grades|modules|quizzes|files|inbox|messages|go back|back|help|read page|next section|repeat|compose)\b/.test(u) ||
      /\b(due today|due this week|what'?s due|overdue|next due|upcoming)\b/.test(u);

    if (looksLikeNewCommand) {
      await mem.set({ expectingChoice: false, choiceOptions: null });
    } else {
      const idx = ordinalToIdx(cleaned);
      if (idx != null) {
        const r = await runAction(intents.CHOOSE_OPTION, { idx: String(idx + 1) });
        await mem.set({ lastHeard: cleaned, lastIntent: intents.CHOOSE_OPTION });
        return { intent: intents.CHOOSE_OPTION, result: { ...r, confidence: 0.99, reason: "forced choice parse" } };
      }

      await speak("Say option 1, option 2, and so on.", { mode: "say" });
      return {
        intent: intents.CHOOSE_OPTION,
        result: { ok: false, message: "Expecting choice", confidence: 0.9, reason: "expectingChoice" },
      };
    }
  }

  // -------------------------------------------------------------------------
  // 23.4) Single-utterance "section from course"
  // -------------------------------------------------------------------------
  const special = parseSectionFromCourseChunk(cleaned);
  if (special && special.length >= 2) {
    await speak("Okay. Doing that now.", { mode: "say" });
    try { __CONVOX.actions.clearResumePlan?.(); } catch {}
    await clearPlan();

    await setPlan(special, {
      kind: "SECTION_FROM_COURSE",
      rawUtterance: cleaned,
      createdAt: Date.now(),
    });

    await resumePlanIfAny();
    await mem.set({ lastHeard: cleaned, lastIntent: "SECTION_FROM_COURSE" });
    return {
      intent: "SECTION_FROM_COURSE",
      result: { ok: true, message: "Planned section-from-course", confidence: 0.95 },
    };
  }

  // -------------------------------------------------------------------------
  // 23.5) Dynamic chained commands
  // -------------------------------------------------------------------------
  const expanded = expandCourseScopedCommand(cleaned);
  const chunks = expanded?.length ? expanded : splitChainedCommands(cleaned);

  if (chunks.length >= 2) {
    const baseCtx = await mem.get();

    const steps = [];
    for (const ch of chunks) {
      const compiled = await compileChunkToSteps(ch, detector, baseCtx);
      if (Array.isArray(compiled) && compiled.length) steps.push(...compiled);
    }

    if (steps.length >= 2) {
      await speak("Okay. Doing that now.", { mode: "say" });
      try { __CONVOX.actions.clearResumePlan?.(); } catch {}
      await clearPlan();

      await setPlan(steps, {
        kind: "CHAINED_COMMANDS",
        rawUtterance: cleaned,
        createdAt: Date.now(),
      });

      await resumePlanIfAny();
      await mem.set({ lastHeard: cleaned, lastIntent: "CHAINED_COMMANDS" });

      return {
        intent: "CHAINED_COMMANDS",
        result: { ok: true, message: "Planned chained commands", confidence: 0.95, reason: "plan chain" },
      };
    }
  }

  // -------------------------------------------------------------------------
  // 23.6) Existing compound command intercepts (pre-NLU)
  // -------------------------------------------------------------------------
  const compoundA = parseCompoundAssignmentsForCourse(cleaned);
  if (compoundA?.courseNum) {
    const r = await actOpenAssignmentsForCourse(compoundA.courseNum);
    await mem.set({ lastHeard: cleaned, lastIntent: "OPEN_ASSIGNMENTS_FOR_COURSE" });
    return { intent: "OPEN_ASSIGNMENTS_FOR_COURSE", result: { ...r, confidence: 0.96, reason: "compound pre-NLU" } };
  }

  const compoundB = parseCompoundAssignmentDueInCourse(cleaned);
  if (compoundB?.courseNum) {
    const r = await actOpenAssignmentDueInCourse(compoundB);
    await mem.set({ lastHeard: cleaned, lastIntent: "OPEN_ASSIGNMENT_DUE_IN_COURSE" });
    return { intent: "OPEN_ASSIGNMENT_DUE_IN_COURSE", result: { ...r, confidence: 0.95, reason: "compound pre-NLU" } };
  }

  // Pre-NLU: course open queries
  if (/^open\s+/i.test(cleaned)) {
    const q = parseCourseQueryFromUtterance(cleaned);
    if (q && (q.dept || q.num || /\bcourse\b/i.test(q.remainder))) {
      const r = await actOpenCourseByQuery(cleaned);
      if (r?.ok) {
        await mem.set({ lastHeard: cleaned, lastIntent: "COURSE_QUERY" });
        return { intent: "COURSE_QUERY", result: { ...r, confidence: 0.95, reason: "course-query pre-NLU" } };
      }
    }
  }

  // -------------------------------------------------------------------------
  // 23.7) Detector fallback + execution
  // -------------------------------------------------------------------------
  const context = await mem.get();
  const det = await detector(cleaned, context);

  let { intent, slots, confidence, reason } = det || {};
  intent = intent || intents.UNKNOWN;
  slots = slots || {};
  confidence = typeof confidence === "number" ? confidence : 0.25;
  reason = reason || "detector";

  if (
    intent === intents.SMALL_TALK ||
    intent === intents.QA_GENERAL ||
    intent === intents.LOG_IN ||
    intent === intents.COMPOSE_MESSAGE ||
    intent === intents.ADD_DISCUSSION
  ) {
    slots.utterance = cleaned;
  }

  if (confidence < 0.45 && intent === intents.UNKNOWN) {
    intent = intents.QA_GENERAL;
    slots = { ...(slots || {}), utterance: cleaned };
    confidence = Math.max(confidence, 0.35);
    reason = `auto-upgrade: unknown->QA_GENERAL (${reason})`;
  }

  if (confidence < 0.45 && intent !== intents.HELP && intent !== intents.SMALL_TALK && intent !== intents.QA_GENERAL) {
    await speak("Not sure what you meant. Try: dashboard, courses, assignments, grades, or back.", { mode: "say" });
    await mem.set({
      expectingYesNo: false,
      pendingAction: null,
      lastIntent: intents.UNKNOWN,
      expectingChoice: false,
      choiceOptions: null,
    });
    return { intent, result: { ok: false, message: "Low confidence; clarify", confidence, reason } };
  }

  const result = await runAction(intent, slots);
  await mem.set({ lastHeard: cleaned, lastIntent: intent });
  return { intent, result: { ...result, confidence, reason } };
}


// =============================================================================
// 24) Time helpers (America/Chicago safe)
// =============================================================================

const USER_TZ = "America/Chicago";

function dtParts(date, timeZone = USER_TZ) {
	const dtf = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hour12: false,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
	const parts = dtf.formatToParts(date);
	const map = {};
	for (const p of parts) if (p.type !== "literal") map[p.type] = p.value;
	return map;
}

function getOffsetMs(date, timeZone = USER_TZ) {
	const p = dtParts(date, timeZone);
	const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
	return asUTC - date.getTime();
}

function zonedTimeToUtc({ year, month, day, hour = 0, minute = 0, second = 0, ms = 0 }, timeZone = USER_TZ) {
	const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second, ms));
	const offset = getOffsetMs(utcGuess, timeZone);
	return new Date(utcGuess.getTime() - offset);
}

function startEndOfToday(timeZone = USER_TZ) {
	const now = new Date();
	const p = dtParts(now, timeZone);
	const y = +p.year,
		m = +p.month,
		d = +p.day;
	const start = zonedTimeToUtc({ year: y, month: m, day: d, hour: 0, minute: 0, second: 0, ms: 0 }, timeZone);
	const end = zonedTimeToUtc({ year: y, month: m, day: d, hour: 23, minute: 59, second: 59, ms: 999 }, timeZone);
	return { start, end };
}

function rangeNextDays(days = 7, timeZone = USER_TZ) {
	const { start } = startEndOfToday(timeZone);
	const end = new Date(start.getTime() + days * 24 * 60 * 60 * 1000 - 1);
	return { start, end };
}

function toLocalDueLabel(isoString, timeZone = USER_TZ) {
	if (!isoString) return "";
	const d = new Date(isoString);
	if (isNaN(d.getTime())) return "";

	const dtf = new Intl.DateTimeFormat("en-US", {
		timeZone,
		weekday: "short",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
	return dtf.format(d);
}

// =============================================================================
// 25) Due item collection (Canvas API + DOM snapshot merge)
// =============================================================================

async function collectRelevantItems({ startISO, endISO } = {}) {
	// 1) Canvas API truth layer
	let planner = [];
	let todo = [];

	try {
		planner = await fetchPlannerItems({ startDateISO: startISO, endDateISO: endISO });
	} catch (e) {
		console.warn("planner fetch failed:", e);
	}

	try {
		todo = await fetchUserTodo();
	} catch (e) {
		console.warn("todo fetch failed:", e);
	}

	const apiItems = []
		.concat(planner || [])
		.concat(todo || [])
		.map(normalizeCanvasItem);

	// 2) Screen snapshot (fallback + context)
	let snap = null;
	try {
		snap = buildSnapshot();
	} catch (e) {
		console.warn("snapshot build failed:", e);
	}

	const snapItems = (snap?.items || []).map((x) => ({
		title: x.title,
		dueAt: x.dueAt || null, // may be human text, not ISO
		courseName: x.courseName || null,
		url: x.url || null,
		raw: x,
		type: "dom",
	}));

	// Deduplicate primarily by URL + title
	const seen = new Set();
	const merged = [];
	for (const it of [...apiItems, ...snapItems]) {
		const key = ((it.url || "") + "|" + it.title).toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(it);
	}

	return { items: merged, snapshot: snap };
}

function filterItemsByRange(items, start, end) {
	const s = start.getTime();
	const e = end.getTime();

	return items.filter((it) => {
		if (!it?.dueAt) return false;
		const t = new Date(it.dueAt).getTime();
		if (isNaN(t)) return false;
		return t >= s && t <= e;
	});
}

function filterOverdue(items, now = new Date()) {
	const n = now.getTime();
	return items.filter((it) => {
		if (!it?.dueAt) return false;
		const t = new Date(it.dueAt).getTime();
		if (isNaN(t)) return false;
		// if submitted is explicitly true, don’t call it overdue
		if (it.submitted === true) return false;
		return t < n;
	});
}

function sortByDue(items) {
	return [...items].sort((a, b) => {
		const ta = new Date(a.dueAt || 0).getTime();
		const tb = new Date(b.dueAt || 0).getTime();
		return ta - tb;
	});
}

// =============================================================================
// 26) Due answer speaking (deterministic + optional LLM phrasing)
// =============================================================================

function isMidnightLabel(label) {
	return /\b12:00\s*AM\b/i.test(String(label || ""));
}

function wantsAssignmentsOnly(utterance) {
	const u = String(utterance || "").toLowerCase();
	// If they say “assignment(s)” we filter. Otherwise include planner items too.
	return /\bassignments?\b/.test(u);
}

function isAssignmentItem(it) {
	if (!it) return false;
	if (String(it.type || "").toLowerCase() === "assignment") return true;
	const pt = it.raw?.plannable_type || it.raw?.plannable?.plannable_type;
	return String(pt || "").toLowerCase() === "assignment";
}

async function speakSmartAnswer({ question, items, totalCount, utterance }) {
	const count = typeof totalCount === "number" ? totalCount : items?.length || 0;
	const top = (items || []).slice(0, 3).map((x) => {
		let dueLabel = x.dueAt ? toLocalDueLabel(x.dueAt) : "";
		if (isMidnightLabel(dueLabel)) {
			// Cleaner audio: treat midnight as “date-only”
			dueLabel = dueLabel.replace(/\s*,?\s*12:00\s*AM\b/i, "");
		}
		return dueLabel ? `${x.title} (due ${dueLabel})` : x.title;
	});

	// Deterministic base (always works)
	let base = "";
	if (!count) {
		base = "No assignments due in that time window.";
	} else {
		const showing = top.length;
		base = `You have ${count} due. Here ${showing === 1 ? "is" : "are"} the next ${showing}: ${top.join(", ")}.`;
		if (count > showing) base += " Want the full list or just the next five?";
	}

	// LLM phrasing (optional; safe fallback)
	try {
		const todayISO = new Date().toISOString().slice(0, 10);
		const llm = await llmAnswerQuestion({
			question: question || utterance || "What's due?",
			items: (items || []).slice(0, 8).map((x) => ({
				title: x.title,
				dueAt: x.dueAt,
				dueLabel: x.dueAt ? toLocalDueLabel(x.dueAt) : null,
				courseName: x.courseName,
				type: x.type || null,
			})),
			tz: USER_TZ,
			todayISO,
		});

		const final = llm ? await llmRewriteForSpeech(llm) : base;
		await speak(final, { mode: "say" });
		return { ok: true, message: "Spoke smart answer" };
	} catch (e) {
		console.warn("LLM answer failed:", e);
		await speak(base, { mode: "say" });
		return { ok: true, message: "Spoke fallback answer" };
	}
}

// =============================================================================
// 27) Due intents (today / this week / next due / overdue)
// =============================================================================

async function actDueToday(slots = {}) {
	const { start, end } = startEndOfToday(USER_TZ);
	const { items } = await collectRelevantItems({
		startISO: start.toISOString(),
		endISO: end.toISOString(),
	});

	const utterance = slots.utterance || "";
	let due = sortByDue(filterItemsByRange(items, start, end));

	// Filter to assignments only if user asked “assignments”
	if (wantsAssignmentsOnly(utterance)) due = due.filter(isAssignmentItem);

	return await speakSmartAnswer({
		question: "What assignments are due today?",
		items: due.slice(0, 3),
		totalCount: due.length,
		utterance,
	});
}

async function actDueThisWeek(slots = {}) {
	const { start, end } = rangeNextDays(7, USER_TZ);
	const { items } = await collectRelevantItems({
		startISO: start.toISOString(),
		endISO: end.toISOString(),
	});

	const utterance = slots.utterance || "";
	let due = sortByDue(filterItemsByRange(items, start, end));

	if (wantsAssignmentsOnly(utterance)) {
		due = due.filter(isAssignmentItem);
	}

	// This stores the list cursor so user can say "more" / "next five" / "full list"
	await mem.set({
		expectingList: {
			kind: "DUE_LIST",
			createdAt: Date.now(),
			items: due,
			cursor: 0,
		},
	});

	return await speakSmartAnswer({
		question: "How many assignments are due this week?",
		items: due.slice(0, 3),
		totalCount: due.length,
		utterance,
	});
}

async function actNextDue() {
	const { start, end } = rangeNextDays(14, USER_TZ); // look slightly ahead
	const { items } = await collectRelevantItems({
		startISO: start.toISOString(),
		endISO: end.toISOString(),
	});

	const due = sortByDue(filterItemsByRange(items, start, end));
	const next = due.slice(0, 1);
	return await speakSmartAnswer({ question: "What is next due?", items: next });
}

async function actOverdue() {
	// Overdue doesn’t need a date range, but Planner gives better coverage if we fetch a reasonable window:
	const { start, end } = rangeNextDays(60, USER_TZ);
	const { items } = await collectRelevantItems({
		startISO: start.toISOString(),
		endISO: end.toISOString(),
	});

	const overdue = sortByDue(filterOverdue(items, new Date()));
	return await speakSmartAnswer({ question: "Do I have any overdue assignments?", items: overdue.slice(0, 8) });
}

// =============================================================================
// 28) QA (deterministic date/time + optional LLM)
// =============================================================================
async function actGeneralQA(utterance) {
	const state = await mem.get();
	const u = normalize(utterance || "");

	// Deterministic: date / time / “today”
	if (
		/\b(what'?s|whats)\s+(today)\b/.test(u) ||
		/\b(what day is it|day is it)\b/.test(u) ||
		(/\b(today)\b/.test(u) && /\b(date)\b/.test(u))
	) {
		const d = new Date();
		const label = new Intl.DateTimeFormat("en-US", {
			timeZone: USER_TZ,
			weekday: "long",
			month: "long",
			day: "numeric",
			year: "numeric",
		}).format(d);

		await speak(`Today is ${label}.`, { mode: "say" });
		return { ok: true, message: "Answered today/date" };
	}

	if (/\b(time)\b/.test(u) && (/\b(now|right now|current)\b/.test(u) || /\bwhat\b/.test(u))) {
		const d = new Date();
		const label = new Intl.DateTimeFormat("en-US", {
			timeZone: USER_TZ,
			hour: "numeric",
			minute: "2-digit",
		}).format(d);

		await speak(`It’s ${label}.`, { mode: "say" });
		return { ok: true, message: "Answered time" };
	}

	// Greetings/check-ins → set follow-up context
	if (/\b(hi|hello|hey|how are you|how’s it going|whats up|what's up)\b/.test(u)) {
		await mem.set({
			expectingFollowUp: {
				kind: "DUE_PICK",
				createdAt: Date.now(),
			},
		});

		await speak("I’m doing good. Want due today, due this week, or open a course?", { mode: "say" });
		return { ok: true, message: "Greeting + follow-up set" };
	}

	// What can you do?
	if (/\b(what can you do|what do you do|capabilities)\b/.test(u)) {
		await speak(
			"I can help you navigate Canvas. Try: what assignments are due today, what’s due this week, open a course, or open grades.",
			{ mode: "say" }
		);
		return { ok: true, message: "Explained capabilities" };
	}

		await speak(
			"I can help with Canvas. Try: what assignments are due today, what’s due this week, open courses, open assignments, open modules, open quizzes, open files, or open grades.",
			{ mode: "say" }
		);
		return { ok: true, message: "QA_GENERAL fallback" };
	}

	// =============================================================================
	// 29) Bootstrap: always install auto-resume hooks
	// =============================================================================

	try {
		initAutoResume();
	} catch (e) {
		console.warn("initAutoResume failed:", e);
	}

	// =============================================================================
	// 30) Other Helpers
	// =============================================================================

	function hardNavigateNow(href) {
		try {
			const url = new URL(String(href || ""), location.origin).toString();
			window.location.assign(url);
		} catch {
			window.location.href = href;
		}
	}

	async function navigateTopLevel(url) {
		const href = new URL(String(url || ""), location.origin).toString();

		// Prefer background navigation (most reliable)
		if (typeof chrome !== "undefined" && chrome?.runtime?.sendMessage) {
			try {
				const resp = await chrome.runtime.sendMessage({ type: "CONVOX_NAVIGATE", url: href });
				if (resp?.ok) return true;
				console.warn("CONVOX_NAVIGATE failed:", resp);
			} catch (e) {
				console.warn("CONVOX_NAVIGATE sendMessage error:", e);
			}
		}

		// Fallback
		window.location.assign(href);
		return true;
	}
