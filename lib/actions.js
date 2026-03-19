// lib/actions.js
// PERSON B — Action router for detected intents.
// Depends on intent enums + Memory from lib/intent.js

import { intents, Memory, normalize } from "./intent.js";
import { fetchPlannerItems, fetchUserTodo, normalizeCanvasItem } from "./canvas_api.js";
import { buildSnapshot } from "./snapshot.js";
import { llmAnswerQuestion, llmRewriteForSpeech } from "./tiny_llm.js";
import { llmChatGeneral } from "./tiny_llm.js";

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

	// --- NEW: "core" -> "course" (common ASR mistake) ---
	// ex: "open assignments for core csce 4901"
	u = u.replace(/\bcore\b/gi, "course");

	// --- NEW: normalize Sprint number words (helps link matching) ---
	// ex: "open sprint one" -> "open sprint 1"
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

function findBestLink({ keywords = [], hrefHints = [] }) {
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
	if (best && bestScore >= 2.0) return best;
	return null;
}

function findCanvasSubmitButton() {
	// Canvas uses a real <button> with visible text "Submit Assignment"
	const buttons = Array.from(document.querySelectorAll("button"));
	for (const btn of buttons) {
		const text = (btn.textContent || "").trim().toLowerCase();
		if (text === "submit assignment") return btn;
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
	});
}
// =============================================================================
// 4.5) Multi-step plan runner (persists across navigation)
// =============================================================================

const PLAN_KEY = "plan";
const PLAN_LOCK_KEY = "planLock"; // prevents double-run

const NAV_INTENTS = new Set([
	intents.OPEN_COURSE_BY_NUMBER,
	intents.OPEN_ASSIGNMENTS,
	intents.OPEN_COURSES,
	intents.OPEN_DASHBOARD,
	intents.NAVIGATE_TO,
	intents.GO_BACK,
	intents.OPEN_ASSIGNMENT_QUERY,
	intents.CHOOSE_OPTION,
]);

async function setPlan(steps, meta = {}) {
	await mem.set({
		[PLAN_KEY]: {
			id: Date.now(),
			i: 0,
			steps, // [{ intent, slots }]
			...meta,
		},
		[PLAN_LOCK_KEY]: false,
	});
}

async function clearPlan() {
	await mem.set({ [PLAN_KEY]: null, [PLAN_LOCK_KEY]: false });
}

async function resumePlanIfAny() {
	const st = await mem.get();
	const plan = st?.[PLAN_KEY];
	const locked = st?.[PLAN_LOCK_KEY];

	if (!plan || !Array.isArray(plan.steps) || plan.i == null) return;
	if (locked) return; // another resume is running

	// Never auto-run while user must choose something
	if (st?.expectingChoice) return;

	await mem.set({ [PLAN_LOCK_KEY]: true });

	try {
		// run until we hit a navigation step OR plan ends
		while (plan.i < plan.steps.length) {
			const step = plan.steps[plan.i];
			if (!step?.intent) {
				plan.i++;
				continue;
			}

			const result = await runAction(step.intent, step.slots || {});
			plan.i++;

			// persist progress immediately
			await mem.set({ [PLAN_KEY]: plan });

			// if it likely navigates, stop here and let next page resume
			if (NAV_INTENTS.has(step.intent)) break;

			// if action failed, stop (don’t loop forever)
			if (!result?.ok) break;
		}

		// plan finished
		if (plan.i >= plan.steps.length) await clearPlan();
	} catch (e) {
		console.warn("resumePlanIfAny error:", e);
		// keep plan so it can retry next navigation
	} finally {
		await mem.set({ [PLAN_LOCK_KEY]: false });
	}
}

// =============================================================================
// 5) Choice mode
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
	const t = String(x || "")
		.toLowerCase()
		.trim();

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
// 6) Course lookup improvements (exact + partial + name + list-all fallback)
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
		document.querySelectorAll("a[href*='/courses/'], .ic-DashboardCard__link, [role='link']"),
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
	// Only handles "open ..." style course asks. Returns null if not course-ish.
	const s = String(cleaned || "")
		.toLowerCase()
		.trim();

	// Must start with open to avoid catching random mentions
	if (!s.startsWith("open ")) return null;

	// strip leading "open"
	const remainder = s.replace(/^open\s+/, "").trim();

	// If user explicitly says course, treat as course query
	if (/\bcourse\b/.test(remainder)) {
		const numMatch = remainder.match(/\b(\d{1,4})\b/);
		const num = numMatch ? numMatch[1] : null;
		const deptMatch = remainder.match(/\b(csce|cse|csc|cs)\b/);
		const dept = deptMatch ? deptMatch[1] : null;
		return { dept, num, remainder };
	}

	// If user says a CS dept token, treat as course query
	const deptMatch = remainder.match(/\b(csce|cse|csc|cs)\b/);
	const dept = deptMatch ? deptMatch[1] : null;
	if (dept) {
		const numMatch = remainder.match(/\b(\d{1,4})\b/);
		const num = numMatch ? numMatch[1] : null;
		return { dept, num, remainder };
	}

	// IMPORTANT CHANGE:
	// Only treat a number as a course number if it's 4 digits.
	// This prevents "open sprint 3" from being misread as a course query.
	const numMatch = remainder.match(/\b(\d{4})\b/);
	const num = numMatch ? numMatch[1] : null;
	if (num) return { dept: null, num, remainder };

	// Otherwise: not a course query
	return null;
}

function scoreCourseCandidate(label, href, q) {
	const L = normalizeCourseLabel(label).toLowerCase();
	const H = String(href || "").toLowerCase();

	let score = 0;

	// Dept scoring
	if (q.dept) {
		if (L.includes(q.dept)) score += 2.0;
		// treat "cse" -> "csce" as close
		if (q.dept === "cse" && L.includes("csce")) score += 1.2;
		if (q.dept === "cs" && (L.includes("csce") || L.includes("cse"))) score += 1.0;
	}

	// Number scoring
	if (q.num) {
		// exact 4-digit match is strongest
		const exact4 = q.num.length === 4 && new RegExp(`\\b${q.num}\\b`).test(L);
		if (exact4) score += 5.0;

		// prefix match (490 matches 4901) BUT should be treated as ambiguous
		if (!exact4 && L.includes(q.num)) score += 2.0;

		// also check href (some labels omit number)
		if (H.includes(q.num)) score += 0.8;
	}

	// token overlap (course title fragments)
	const tokens = q.remainder
		.replace(/\b(open|course|csce|cse|cs)\b/g, "")
		.replace(/[^\w\s]/g, " ")
		.split(/\s+/)
		.filter((t) => t.length >= 3);

	for (const t of tokens) {
		if (L.includes(t)) score += 0.7;
	}

	// Prefer course-home links
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

		// de-dupe by href (same course appears multiple times)
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
	// If not an exact match, confirm instead of instantly opening.
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

	// If user is extremely vague like "open csce" or "open course"
	if ((!q.num || q.num.length < 4) && (!q.remainder || q.remainder.length <= 6)) {
		// filter by dept if possible
		let filtered = all;
		if (q.dept) {
			filtered = all.filter((o) => normalizeCourseLabel(o.label).toLowerCase().includes(q.dept));
			// cse -> csce helpful
			if (!filtered.length && q.dept === "cse") {
				filtered = all.filter((o) => normalizeCourseLabel(o.label).toLowerCase().includes("csce"));
			}
		}

		if (filtered.length) {
			const prompt = "That’s not a full course name. Here are the closest matches.";
			await askChoice(
				filtered.slice(0, 8).map((o) => ({ label: o.label, href: o.href })),
				prompt,
			);
			return { ok: true, message: "Asked user to choose course (vague query)" };
		}

		return await actListCoursesFallback("I didn’t catch the exact course. Here are all your courses.");
	}

	// Score candidates
	const scored = all
		.map((o) => ({
			...o,
			score: scoreCourseCandidate(o.label, o.href, q),
		}))
		.sort((a, b) => b.score - a.score);

	const best = scored[0];
	const strong = best && best.score >= 5.0; // usually exact 4-digit hit

	// If nothing decent matched → list all courses
	if (!best || best.score < 2.2) {
		const prompt = `I couldn’t find a course matching "${q.remainder}". Here are all your courses.`;
		return await actListCoursesFallback(prompt);
	}

	// If query is partial number (len < 4), ALWAYS show choices
	if (q.num && q.num.length < 4) {
		const similar = scored.filter((x) => x.score >= best.score - 2.0).slice(0, 8);
		const prompt = `That looks incomplete ("${q.num}"). Which one do you mean?`;
		await askChoice(
			similar.map((o) => ({ label: o.label, href: o.href })),
			prompt,
		);
		return { ok: true, message: "Asked choice (partial course number)" };
	}

	// If not strong/exact, confirm first (don’t auto-open)
	if (!strong) {
		const similar = scored.filter((x) => x.score >= best.score - 1.3).slice(0, 8);
		return await actConfirmOrChooseCourse(best, similar, q.remainder);
	}

	// Strong match: open immediately
	await speak(`Opening ${best.label}.`, { mode: "say" });
	try {
		clickAndNavigate(best.el);
	} catch {
		window.location.href = best.href;
	}

	await remember({
		lastIntent: intents.OPEN_COURSE_BY_NUMBER,
		lastLinkText: best.label,
		lastLinkHref: best.href,
		activeCourseHref: best.href,
	});
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
// 6.5) Queue (multi-step commands across navigation)
// =============================================================================

async function setQueue(steps = [], meta = {}) {
	await mem.set({
		pendingQueue: steps,
		pendingQueueMeta: { createdAt: Date.now(), ...meta },
		pendingQueueRunning: false,
	});
}

async function clearQueue() {
	await mem.set({ pendingQueue: null, pendingQueueMeta: null, pendingQueueRunning: false });
}

async function shiftQueue() {
	const st = await mem.get();
	const q = Array.isArray(st.pendingQueue) ? [...st.pendingQueue] : [];
	q.shift();
	await mem.set({ pendingQueue: q.length ? q : null });
	return q;
}

function parseCourseNumberFromText(t = "") {
	const s = String(t).toLowerCase();
	// accept csce/cse/csc + 4 digits OR just 4 digits
	const m = s.match(/\b(?:csce|cse|csc|cs)\s*(\d{4})\b/i) || s.match(/\b(\d{4})\b/);
	return m ? m[1] : null;
}

function parseMonthDay(text = "") {
	// supports: feb 21, february 21, 2/21, 02/21
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
		/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t)?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b[^0-9]{0,6}\b(0?[1-9]|[12]\d|3[01])\b/,
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

	// accept numeric date "2/21"
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

// =============================================================================
// 7) Assignment lookup (HW 2, Homework 2, Assignment 2)
// =============================================================================

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
	const candidates = Array.from(document.querySelectorAll("input[type='text'], input[role='searchbox'], input")).filter(
		Boolean,
	);

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
		(a) => a && (a.href || a.getAttribute("href")),
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
			`I found a few matches for ${qText}. Which one?`,
		);
		return { ok: true, message: "Asked choice for assignment" };
	}

	await speak(`Opening ${scored[0].label}.`, { mode: "say" });
	window.location.href = scored[0].href;
	return { ok: true, message: `Opened assignment: ${scored[0].label}` };
}

async function actReadAssignmentsSummary() {
	const items = Array.from(
		document.querySelectorAll("a[href*='/assignments/'], .assignment a, .ig-title a, [data-testid*='assignment'] a"),
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
// 7.5) Compound actions (course + assignments + due date)
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

	// Ensure we are on assignments page
	if (!location.pathname.includes("/assignments")) {
		// Queue this step after assignments loads (append if already queued)
		const st = await mem.get();
		const existing = Array.isArray(st.pendingQueue) ? st.pendingQueue : [];
		await setQueue([...existing, { intent: INTERNAL_INTENTS.OPEN_ASSIGNMENT_DUE_IN, slots: { md } }], {
			kind: "OPEN_ASSIGNMENT_DUE_IN",
		});

		await speak("Opening assignments first.", { mode: "say" });
		return await actOpenAssignments();
	}

	// Wait for links to render
	await waitFor(() => collectAssignmentLinks().length > 0, { timeoutMs: 3500 });

	const matches = await findAssignmentByDueMonthDay(md);

	if (!matches.length) {
		await speak("I couldn’t find an assignment with that due date here. Say: read the page.", { mode: "say" });
		return { ok: false, message: "No due-date matches" };
	}

	if (matches.length > 1) {
		await askChoice(
			matches.slice(0, 8).map((m) => ({ label: m.label || "Assignment", href: m.href })),
			"I found a few assignments due that day. Which one?",
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

	// Queue: after course opens, open assignments
	await setQueue([{ intent: intents.OPEN_ASSIGNMENTS, slots: {} }], {
		kind: "OPEN_ASSIGNMENTS_FOR_COURSE",
		courseNum,
	});

	await speak(`Opening course ${courseNum}, then assignments.`, { mode: "say" });
	return await actOpenCourseByNumber(courseNum);
}

function parseCompoundAssignmentsForCourse(cleaned) {
	// "open assignments for course csce 4901"
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
	// "open assignment due feb 21 in course csce 4901"
	const u = String(cleaned || "").toLowerCase();

	const hasOpen = /\bopen\b/.test(u);
	const hasAssignment = /\bassignment\b/.test(u) || /\bhomework\b/.test(u);
	const hasDue = /\bdue\b/.test(u);
	const courseNum = parseCourseNumberFromText(u);
	if (!(hasOpen && hasAssignment && hasDue && courseNum)) return null;

	// use everything after "due" as due text (actions will parse Month/Day)
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

	// Queue: after course opens, open assignments, then open due-date assignment
	await setQueue(
		[
			{ intent: intents.OPEN_ASSIGNMENTS, slots: {} },
			{ intent: INTERNAL_INTENTS.OPEN_ASSIGNMENT_DUE_IN, slots: { md } },
		],
		{ kind: "DUE_IN_COURSE", courseNum, md, dueText },
	);

	await speak(`Opening course ${courseNum}, then assignments due ${dueText || "that day"}.`, { mode: "say" });
	return await actOpenCourseByNumber(courseNum);
}

// =============================================================================
// 8) Navigation primitives
// =============================================================================

async function actGoBack() {
	try {
		window.history.back();
		await speak("Going back.", { mode: "say" });
		await clearStickyModes();
		return { ok: true, message: "Went back" };
	} catch (e) {
		await speak("I can't go back. Want me to open dashboard?", { mode: "say" });
		await mem.set({ expectingYesNo: true, pendingAction: "OPEN_DASHBOARD" });
		return { ok: false, message: "Back failed" };
	}
}

async function actOpenDashboard() {
	const candidates = [
		{ keywords: ["dashboard", "home"], hrefHints: ["/dashboard"] },
		{ keywords: ["home"], hrefHints: ["/dashboard"] },
		{ keywords: ["dashboard"], hrefHints: ["/dashboard"] },
		{ keywords: ["courses", "course"], hrefHints: ["/courses"] },
	];

	let link = null;
	for (const c of candidates) {
		link = findBestLink(c);
		if (link) break;
	}

	if (link) {
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
// 9) Small talk
// =============================================================================

async function actSmallTalk(utterance) {
	const state = await mem.get();

	// Quick deterministic wins for ultra-common phrases (fast + reliable)
	const u = normalize(utterance);
	if (/\b(thanks|thank you|appreciate)\b/.test(u)) {
		await speak("You got it.", { mode: "say" });
		return { ok: true, message: "Small talk: thanks" };
	}

	// For everything else, let the LLM handle it naturally.
	const reply = await llmChatGeneral({
		utterance,
		context: {
			lastIntent: state.lastIntent,
			activeCourseName: state.activeCourseName,
		},
		maxSentences: 2,
	});

	if (reply && reply.trim()) {
		await speak(reply.trim(), { mode: "say" });
		return { ok: true, message: "Small talk: llm" };
	}

	// Fallback if Ollama is off
	await speak("Hey. Want due today, due this week, or open a course?", { mode: "say" });
	return { ok: true, message: "Small talk: fallback" };
}

// =============================================================================
// 10) Canvas page actions
// =============================================================================

async function actOpenGrades() {
	const link = findBestLink({
		keywords: ["grades", "grade", "marks", "score", "results"],
		hrefHints: ["/grades"],
	});
	if (link) {
		const label = (link.textContent || "Grades").trim();
		clickAndNavigate(link);
		await speak(`Opening ${label}.`, { mode: "say" });
		await remember({ lastIntent: intents.OPEN_GRADES, lastLinkText: label, lastLinkHref: link.href });
		return { ok: true, message: `Opened: ${label}` };
	}
	await speak("I can't find Grades here. Want dashboard?", { mode: "say" });
	await remember({ expectingYesNo: true, pendingAction: "OPEN_DASHBOARD" });
	return { ok: false, message: "Grades link not found" };
}

async function actOpenAssignments() {
	const state = await mem.get();
	const activeHref = state.activeCourseHref;

	if (activeHref && /\/courses\/\d+/.test(activeHref)) {
		const courseScoped = findBestLink({
			keywords: ["assignments", "assignment", "tasks", "homework"],
			hrefHints: ["/assignments"],
		});
		if (courseScoped) {
			const label = (courseScoped.textContent || "Assignments").trim();
			clickAndNavigate(courseScoped);
			await speak("Opening assignments.", { mode: "say" });
			await remember({ lastIntent: intents.OPEN_ASSIGNMENTS, lastLinkText: label, lastLinkHref: courseScoped.href });
			return { ok: true, message: `Opened: ${label}` };
		}
	}

	const link = findBestLink({
		keywords: ["assignments", "assignment", "tasks", "homework", "to do", "to-do"],
		hrefHints: ["/assignments"],
	});
	if (link) {
		const label = (link.textContent || "Assignments").trim();
		clickAndNavigate(link);
		await speak("Opening assignments.", { mode: "say" });
		await remember({ lastIntent: intents.OPEN_ASSIGNMENTS, lastLinkText: label, lastLinkHref: link.href });
		return { ok: true, message: `Opened: ${label}` };
	}
	await speak("I can't find Assignments here. Want dashboard?", { mode: "say" });
	await remember({ expectingYesNo: true, pendingAction: "OPEN_DASHBOARD" });
	return { ok: false, message: "Assignments link not found" };
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
	const target = normalize(targetRaw);
	const words = target.split(" ").filter(Boolean);

	const link = findBestLink({
		keywords: words,
		hrefHints: ["/grades", "/assignments", "/courses", "/modules", "/quizzes", "/files", "/calendar", "/dashboard"],
	});

	if (link) {
		const label = (link.textContent || targetRaw).trim();
		clickAndNavigate(link);
		await speak(`Opening ${label}.`, { mode: "say" });
		await remember({ lastIntent: intents.NAVIGATE_TO, lastLinkText: label, lastLinkHref: link.href });
		return { ok: true, message: `Opened: ${label}` };
	}

	if (target.includes("dashboard") || target.includes("home")) {
		return await actOpenDashboard();
	}

	await speak(`I can't find ${targetRaw}. Try: dashboard, courses, assignments, grades, or back.`, { mode: "say" });
	await remember({
		expectingYesNo: false,
		pendingAction: null,
		expectingChoice: false,
		choiceOptions: null,
		lastIntent: intents.UNKNOWN,
	});
	return { ok: false, message: `Target not found: ${targetRaw}` };
}

async function actSubmitAssignment() {
	const btn = findCanvasSubmitButton();

	if (!btn) {
		speak("I can't submit yet. Please upload your file first, " + "then say submit assignment again.");
		return { ok: false, message: "Submit button not found (likely no file uploaded yet)" };
	}

	clickAndNavigate(btn);
	speak("Submitting your assignment now.");
	return { ok: true, message: "Clicked Submit Assignment" };
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
// 10.5) Summarize page (concise summary + TTS)
// =============================================================================

function extractPageText({ maxChars = 60000 } = {}) {
	// Hide the Convox Test overlay so we summarize the underlying page content (not the widget).
	const __cxUI = document.getElementById("convox-test-container");
	const __cxPrevDisplay = __cxUI ? __cxUI.style.display : null;
	if (__cxUI) __cxUI.style.display = "none";
	try {
		// Prefer the main content region when present (Canvas + many sites).
		const roots = [
			document.querySelector(".ic-Layout-contentMain"),
			document.querySelector("#content"),
			document.querySelector("main"),
			document.querySelector("[role='main']"),
			document.body,
		].filter(Boolean);

		let best = "";
		for (const r of roots) {
			const it = String(r.innerText || "").trim();
			if (it.length > best.length) best = it;
			// If innerText is sparse (collapsed accordions / virtualized views), fall back to textContent.
			if (best.length < 300) {
				const tc = String(r.textContent || "").trim();
				if (tc.length > best.length) best = tc;
			}
		}

		// Include same-origin iframes (Canvas sometimes renders content inside one).
		for (const f of Array.from(document.querySelectorAll("iframe"))) {
			try {
				const doc = f.contentDocument;
				const it = String(doc?.body?.innerText || "").trim();
				if (it.length > best.length) best = it;
				if (best.length < 300) {
					const tc = String(doc?.body?.textContent || "").trim();
					if (tc.length > best.length) best = tc;
				}
			} catch {
				// cross-origin iframe
			}
		}

		return String(best || "")
			.replace(/\r/g, "")
			.replace(/[\t ]+/g, " ")
			.replace(/\n{3,}/g, "\n\n")
			.slice(0, maxChars)
			.trim();
	} finally {
		if (__cxUI) __cxUI.style.display = __cxPrevDisplay;
	}
}

const SUM_STOPWORDS = new Set([
	"the",
	"a",
	"an",
	"and",
	"or",
	"but",
	"if",
	"then",
	"than",
	"so",
	"to",
	"of",
	"in",
	"on",
	"for",
	"with",
	"at",
	"by",
	"from",
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"being",
	"it",
	"this",
	"that",
	"these",
	"those",
	"as",
	"i",
	"you",
	"we",
	"they",
	"he",
	"she",
	"them",
	"his",
	"her",
	"our",
	"your",
	"my",
	"me",
	"us",
	"do",
	"does",
	"did",
	"not",
	"no",
	"yes",
	"can",
	"could",
	"should",
	"would",
	"will",
	"just",
	"about",
	"into",
	"over",
	"under",
	"up",
	"down",
	"out",
	"very",
	"more",
	"most",
	"much",
	"what",
	"when",
	"where",
	"why",
	"how",
]);

function isNoisySummaryLine(s) {
	const t = String(s || "").trim();
	if (!t) return true;
	// UI / nav boilerplate
	if (t.length <= 12) return true;
	if (/^(home|dashboard|account|inbox|calendar|help|settings)$/i.test(t)) return true;
	if (/^(add comment|edit|delete|cancel|ok|submit|save|search)$/i.test(t)) return true;
	if (/\b(view rubric|ratings|full marks|poor quality|medium quality|above average|criteria)\b/i.test(t)) return true;
	if (/\b(log\s*out|privacy|terms|copyright)\b/i.test(t)) return true;
	return false;
}

function splitSummaryUnits(text) {
	const cleaned = String(text || "")
		.replace(/\r/g, "")
		.trim();
	if (!cleaned) return [];

	// Prefer non-trivial lines (keeps bullets/instructions intact).
	const lines = cleaned
		.split(/\n+/g)
		.map((l) => l.replace(/^[-*•\u2022\s]+/, "").trim())
		.filter((l) => l.length >= 24)
		.filter((l) => !isNoisySummaryLine(l));

	// Also include sentence-like chunks for paragraph pages.
	const sents = (cleaned.match(/[^.!?\n]+[.!?]+|[^.!?\n]+$/g) || [])
		.map((s) => s.trim())
		.filter((s) => s.length >= 30)
		.filter((s) => !isNoisySummaryLine(s));

	// Merge, de-dupe by normalized prefix.
	const out = [];
	const seen = new Set();
	for (const unit of [...lines, ...sents]) {
		const key = unit
			.toLowerCase()
			.replace(/[^a-z0-9 ]/g, "")
			.slice(0, 80);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(unit);
		if (out.length >= 260) break;
	}
	return out;
}

function extractCanvasMeta(text) {
	const t = String(text || "");
	const meta = {};

	// Common Canvas snippets: "Due Jan 13, 2026 11:59pm" / "Available ... until ..."
	const due = t.match(/\bDue\b\s*:?\s*([A-Z][a-z]{2,9}\s+\d{1,2},\s+\d{4}[^\n]{0,40})/i);
	if (due?.[1]) meta.due = due[1].trim();

	const avail = t.match(/\bAvailable\b\s*:?\s*([^\n]{10,80})/i);
	if (avail?.[1]) meta.available = avail[1].trim();

	const until = t.match(/\bUntil\b\s*:?\s*([^\n]{10,80})/i);
	if (until?.[1]) meta.until = until[1].trim();

	const pts = t.match(/\b(\d{1,4})\s*pts\b/i) || t.match(/\bPoints\b\s*:?\s*(\d{1,4})\b/i);
	if (pts?.[1]) meta.points = pts[1].trim();

	const attempts = t.match(/\bUnlimited\s+Attempts\s+Allowed\b/i);
	if (attempts) meta.attempts = "Unlimited attempts";

	return meta;
}

function isGreetingOrSignoff(u) {
	const t = String(u || "").trim();
	if (!t) return false;
	if (/^(dear|hi|hello|hey)\b/i.test(t)) return true;
	if (/^(best|thanks|thank you|sincerely|regards)\b/i.test(t)) return true;
	return false;
}

function tokenSetForSummary(u) {
	const words =
		String(u || "")
			.toLowerCase()
			.match(/[a-z0-9]{2,}/g) || [];
	const set = new Set();
	for (const w of words) {
		if (SUM_STOPWORDS.has(w)) continue;
		set.add(w);
		if (set.size >= 60) break;
	}
	return set;
}

function jaccardSim(aSet, bSet) {
	if (!aSet.size || !bSet.size) return 0;
	let inter = 0;
	for (const w of aSet) if (bSet.has(w)) inter++;
	const union = aSet.size + bSet.size - inter;
	return union ? inter / union : 0;
}

function shortenUnitForSummary(u) {
	let line = String(u || "")
		.replace(/\s+/g, " ")
		.trim();
	if (!line) return "";

	// Drop greetings/signoffs that often appear in announcements.
	line = line.replace(/^(dear|hi|hello|hey)\b[^.?!]{0,80}[.?!]\s*/i, "");

	// Keep only the first 1–2 sentences from a long paragraph.
	const sents = (line.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || []).map((s) => s.trim()).filter(Boolean);
	line = sents.slice(0, 2).join(" ").trim();

	// Final hard cap per line.
	if (line.length > 240) line = line.slice(0, 238) + "…";
	return line;
}

function buildSmartSummary(fullText, { maxSentences = 4, maxChars = 520 } = {}) {
	const meta = extractCanvasMeta(fullText);
	const unitsRaw = splitSummaryUnits(fullText);
	if (!unitsRaw.length) return (fullText || "").slice(0, Math.min(maxChars, 240));

	// Pre-shorten units so scoring doesn't reward huge paragraphs.
	const units = unitsRaw
		.map(shortenUnitForSummary)
		.filter((u) => u && u.length >= 28)
		.filter((u) => !isGreetingOrSignoff(u));

	if (!units.length) return (fullText || "").slice(0, Math.min(maxChars, 240));

	// Word frequency (simple TF)
	const freq = new Map();
	for (const u of units) {
		const words = u.toLowerCase().match(/[a-z0-9]{2,}/g) || [];
		for (const w of words) {
			if (SUM_STOPWORDS.has(w)) continue;
			freq.set(w, (freq.get(w) || 0) + 1);
		}
	}

	function bonus(u) {
		let b = 0;
		if (/\b(due|deadline|available|until)\b/i.test(u)) b += 6;
		if (/\b(submit|submission|upload|turn in|complete|purchase|pay)\b/i.test(u)) b += 4;
		if (/\b(required|required component|must|need to|you should|please)\b/i.test(u)) b += 3;
		if (/\b(requirements?|expectations?|instructions?|steps?)\b/i.test(u)) b += 2;
		if (/\b(points?|pts)\b/i.test(u)) b += 1.5;
		if (/\b(office hours|schedule|link|click|log in)\b/i.test(u)) b += 1.5;
		if (
			/\b(\d{1,2}:\d{2}\s*(am|pm)|\d{1,2}\/\d{1,2}\/\d{2,4}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(u)
		)
			b += 1.5;

		// Penalize rubric/ratings boilerplate.
		if (
			/\b(view rubric|ratings|full marks|poor quality|medium quality|above average|criteria|participation|craftsmanship)\b/i.test(
				u,
			)
		)
			b -= 8;

		// De-prioritize title-like lines (very short, header-ish)
		const wc = (u.match(/\b\w+\b/g) || []).length;
		if (wc <= 7 && !/\b(due|deadline|available|until|submit|required|must|need|purchase)\b/i.test(u)) b -= 6;

		// De-prioritize metadata lines (Posted / Author / etc.)
		if (/^posted\b/i.test(u) || /\bauthor\b/i.test(u)) b -= 6;

		return b;
	}

	const scored = units.map((u, idx) => {
		const words = u.toLowerCase().match(/[a-z0-9]{2,}/g) || [];
		let s = 0;
		for (const w of words) s += freq.get(w) || 0;
		s = words.length ? s / Math.sqrt(words.length) : 0;

		// Smaller position bias: don't just read the first paragraph.
		s += Math.max(0, (40 - idx) / 40) * 0.12;

		s += bonus(u);
		return { u, idx, s, ts: tokenSetForSummary(u) };
	});

	// Pool: keep top-N candidates, then diversify with MMR so we don't pick adjacent sentences.
	scored.sort((a, b) => b.s - a.s);
	const pool = scored.slice(0, Math.min(90, scored.length));

	const selected = [];
	const lambda = 0.75; // higher = prioritize importance, lower = prioritize diversity
	while (selected.length < maxSentences && pool.length) {
		let best = null;
		let bestScore = -Infinity;
		for (const c of pool) {
			let sim = 0;
			for (const s of selected) sim = Math.max(sim, jaccardSim(c.ts, s.ts));
			const mmr = lambda * c.s - (1 - lambda) * sim * 10;
			if (mmr > bestScore) {
				bestScore = mmr;
				best = c;
			}
		}
		if (!best) break;
		selected.push(best);
		pool.splice(pool.indexOf(best), 1);
	}

	// Build summary: meta line (if any) + selected lines in importance order.
	const outParts = [];
	const metaBits = [];
	if (meta.due) metaBits.push(`Due ${meta.due}`);
	if (meta.available) metaBits.push(`Available ${meta.available}`);
	if (meta.until) metaBits.push(`Until ${meta.until}`);
	if (meta.points) metaBits.push(`${meta.points} points`);
	if (meta.attempts) metaBits.push(meta.attempts);
	if (metaBits.length) outParts.push(metaBits.join(", ") + ".");

	for (const p of selected) {
		let line = shortenUnitForSummary(p.u);
		if (!line) continue;
		// Avoid repeating meta lines.
		if (meta.due && /\bdue\b/i.test(line)) continue;
		if (outParts.length >= (metaBits.length ? maxSentences + 1 : maxSentences)) break;
		outParts.push(line.endsWith(".") ? line : line + ".");
	}

	let out = outParts.join(" ");
	// Ensure it's concise.
	if (out.length > maxChars) out = out.slice(0, maxChars - 1).trimEnd() + "…";
	return out;
}

async function actSummarizePage() {
	const fullText = extractPageText({ maxChars: 60000 });
	console.log("[Convox] summarize: extracted chars:", fullText.length);

	if (!fullText || fullText.trim().length < 60) {
		await speak(
			"I couldn't find enough text to summarize here. Try scrolling a bit or expanding details, then say summarize again.",
			{ mode: "say" },
		);
		await remember({ lastIntent: intents.UNKNOWN, expectingYesNo: false, pendingAction: null });
		return { ok: false, message: "Not enough text to summarize" };
	}

	// Build a concise summary (never the whole page).
	const summary = buildSmartSummary(fullText, { maxSentences: 4, maxChars: 520 });

	// IMPORTANT: bypass stylizeSpeech truncation (which can collapse long text into just titles).
	// We still keep the summary hard-bounded above.
	const spoken = summary && summary.trim() ? `Summary. ${summary}` : "I couldn't build a good summary from this page.";

	await speak(spoken, { raw: true, lang: "en-US", rate: 1.0, pitch: 1.0, volume: 1.0 });
	await remember({ lastIntent: intents.SUMMARIZE_PAGE, expectingYesNo: false, pendingAction: null });
	return { ok: true, message: "Spoke summary" };
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
		"Try: summarize. Open dashboard. Go back. Open grades. Open assignments. Open courses. Open course 1040. Open homework 2. Read the page. Next section. Repeat.";
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

	// clear yes/no state first
	await remember({ expectingYesNo: false, pendingAction: null });

	if (!isYes) {
		// If user denied course confirmation, show similar/all courses
		if (pending === "OPEN_COURSE_CONFIRM") {
			await mem.set({ pendingHref: null, pendingLabel: null });
			return await actListCoursesFallback("No problem. Here are your courses.");
		}

		await speak("Canceled.", { mode: "say" });
		return { ok: true, message: "Canceled pending action" };
	}

	// YES
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
// 11) Router
// =============================================================================

export async function runAction(intent, slots = {}) {
	switch (intent) {
		case intents.OPEN_GRADES:
			return await actOpenGrades();
		case intents.OPEN_ASSIGNMENTS:
			return await actOpenAssignments();
		case intents.SUBMIT_ASSIGNMENT:
			return await actSubmitAssignment();
		case intents.OPEN_COURSES:
			return await actOpenCourses();

		case intents.OPEN_DASHBOARD:
			return await actOpenDashboard();
		case intents.GO_BACK:
			return await actGoBack();

		case intents.SMALL_TALK:
			return await actSmallTalk(slots.utterance ?? "");

		case intents.OPEN_COURSE_BY_NUMBER:
			// keep original number intent behavior for exact number use-cases
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

		// --- string fallbacks (so you don't need to touch intent.js for compound commands) ---
		case "OPEN_ASSIGNMENTS_FOR_COURSE":
			return await actOpenAssignmentsForCourse(slots.courseNum);
		case INTERNAL_INTENTS.OPEN_ASSIGNMENT_DUE_IN:
			return await actOpenAssignmentDueIn(slots.md);
		case intents.DUE_TODAY:
			return await actDueToday();
		case intents.DUE_THIS_WEEK:
			return await actDueThisWeek();
		case intents.NEXT_DUE:
			return await actNextDue();
		case intents.OVERDUE:
			return await actOverdue();
		case intents.QA_GENERAL:
			return await actGeneralQA(slots.utterance ?? "");

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
// 12) Resume queued steps on page load
// Call this from your content-script init on every page.
// =============================================================================

export async function resumePendingQueue() {
	const st = await mem.get();
	const q = Array.isArray(st.pendingQueue) ? st.pendingQueue : [];
	if (!q.length) return { ok: true, message: "No queue" };

	// prevent re-entrancy loops
	if (st.pendingQueueRunning) return { ok: true, message: "Queue already running" };
	await mem.set({ pendingQueueRunning: true });

	try {
		const step = q[0];
		if (!step?.intent) {
			await clearQueue();
			return { ok: false, message: "Bad queue step" };
		}

		// Give Canvas a moment to render left nav / content
		await new Promise((r) => setTimeout(r, 250));

		// Support special internal step intent string
		if (step.intent === INTERNAL_INTENTS.OPEN_ASSIGNMENT_DUE_IN) {
			const res = await actOpenAssignmentDueIn(step.slots?.md);
			if (res?.ok) await shiftQueue();
			return res;
		}

		const res = await runAction(step.intent, step.slots || {});
		if (res?.ok) await shiftQueue();
		return res;
	} finally {
		await mem.set({ pendingQueueRunning: false });
	}
}
// =============================================================================
// 13) Auto-resume hooks (Canvas SPA safe)
// =============================================================================

let _autoResumeInstalled = false;

export function initAutoResume() {
	if (_autoResumeInstalled) return;
	_autoResumeInstalled = true;

	const fire = () => {
		// tiny debounce so DOM settles a bit
		clearTimeout(window.__convoxResumeTimer);
		window.__convoxResumeTimer = setTimeout(async () => {
			await resumePlanIfAny();
			await resumePendingAnnouncementRead();
			await resumePendingDiscussionWizard();
		}, 250);
	};

	// normal loads
	if (document.readyState === "complete" || document.readyState === "interactive") fire();
	window.addEventListener("load", fire);
	document.addEventListener("DOMContentLoaded", fire);

	// Canvas often uses Turbo/Turbolinks-style navigation
	document.addEventListener("turbo:load", fire);
	document.addEventListener("turbolinks:load", fire);

	// URL changes without reload
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

	window.addEventListener("popstate", () => window.dispatchEvent(new Event("convox:urlchange")));
	window.addEventListener("convox:urlchange", fire);

	// Optional: if Canvas swaps main content without URL changes
	const mo = new MutationObserver(() => fire());
	const root = document.querySelector("#application, #content, main, body");
	if (root) mo.observe(root, { childList: true, subtree: true });
}

// =============================================================================
// 13.1) Convenience: one-shot pipeline
// =============================================================================

export async function handleUtterance(utterance, nluDetect) {
	const detector = nluDetect ?? (await import("./intent.js")).detectIntent;

	const cleaned = normalizeASR(utterance);

	const announcementHandled = await maybeHandleAnnouncementAssist(cleaned);
	if (announcementHandled) {
		let out = announcementHandled;
		if (announcementHandled.intent === intents.QA_GENERAL) {
			out = {
				...announcementHandled,
				result: {
					...(announcementHandled.result || {}),
					confidence:
						typeof announcementHandled?.result?.confidence === "number" ? announcementHandled.result.confidence : 0.35,
					reason: announcementHandled?.result?.reason || "auto-upgrade: unknown->QA_GENERAL (default)",
				},
			};
		}
		await mem.set({ lastHeard: cleaned, lastIntent: out.intent });
		return out;
	}

	const inboxHandled = await maybeHandleInboxAssist(cleaned);
	if (inboxHandled) {
		await mem.set({ lastHeard: cleaned, lastIntent: inboxHandled.intent });
		return inboxHandled;
	}

	const discussionHandled = await maybeHandleDiscussionWizard(cleaned);
	if (discussionHandled) {
		await mem.set({ lastHeard: cleaned, lastIntent: discussionHandled.intent });
		return discussionHandled;
	}

	// Hands-free Canvas Inbox commands: compose, recipient, subject, body, send, cancel.
	const composeHandled = await maybeHandleHandsFreeInbox(cleaned);
	if (composeHandled) {
		await mem.set({ lastHeard: cleaned, lastIntent: composeHandled.intent });
		return composeHandled;
	}

	// ✅ If expecting choice, handle choice — but allow overrides + repeat
	const ctx0 = await mem.get();
	// ✅ Follow-up mode: after assistant asks "due today / due this week / open a course"
	if (ctx0?.expectingFollowUp?.kind === "DUE_PICK") {
		const u = String(cleaned || "")
			.toLowerCase()
			.trim();

		// expire after 30 seconds
		if (Date.now() - (ctx0.expectingFollowUp.createdAt || 0) > 30000) {
			await mem.set({ expectingFollowUp: null });
		} else {
			// map short replies → real intents
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
	// ✅ List follow-up: "full list", "next five", "more"
	if (ctx0?.expectingList?.kind === "DUE_LIST") {
		const u = String(cleaned || "")
			.toLowerCase()
			.trim();

		// expire after 2 minutes
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

				// keep state if more remain
				if (cursor < items.length) {
					await mem.set({ expectingList: { ...ctx0.expectingList, cursor } });
				} else {
					await mem.set({ expectingList: null });
				}
			};

			if (/\b(full list|all of them|everything)\b/.test(u)) {
				await sayRange(50); // cap for sanity; usually enough
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

			// If user says something else, keep list state but fall through
		}
	}

	if (ctx0?.expectingChoice) {
		const u = String(cleaned || "")
			.toLowerCase()
			.trim();

		// 1) allow cancel
		if (/\b(cancel|nevermind|never mind|stop|exit)\b/i.test(u)) {
			await mem.set({ expectingChoice: false, choiceOptions: null });
			await speak("Canceled.", { mode: "say" });
			return { intent: intents.DENY, result: { ok: true, message: "Canceled choice mode", confidence: 0.99 } };
		}

		// 2) repeat options
		if (/\b(repeat|say again|again)\b/i.test(u) && /\b(option|options|choices)\b/i.test(u)) {
			await speakChoiceOptions();
			return { intent: "REPEAT_OPTIONS", result: { ok: true, message: "Repeated options", confidence: 0.99 } };
		}

		// 3) allow new commands to override choice mode
		const looksLikeNewCommand =
			/^open\b/.test(u) ||
			/\b(dashboard|home|courses|assignments|grades|go back|back|help|read page|next section|repeat)\b/.test(u) ||
			/\b(due today|due this week|what'?s due|overdue|next due|upcoming)\b/.test(u);

		if (looksLikeNewCommand) {
			await mem.set({ expectingChoice: false, choiceOptions: null });
			// fall through to normal handling
		} else {
			// 4) otherwise treat it as an option selection
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

	// ✅ NEW: compound command intercepts (pre-NLU)
	// 1) open assignments for course csce 4901
	const compoundA = parseCompoundAssignmentsForCourse(cleaned);
	if (compoundA?.courseNum) {
		const r = await actOpenAssignmentsForCourse(compoundA.courseNum);
		await mem.set({ lastHeard: cleaned, lastIntent: "OPEN_ASSIGNMENTS_FOR_COURSE" });
		return { intent: "OPEN_ASSIGNMENTS_FOR_COURSE", result: { ...r, confidence: 0.96, reason: "compound pre-NLU" } };
	}

	// 2) open assignment due feb 21 in course csce 4901
	const compoundB = parseCompoundAssignmentDueInCourse(cleaned);
	if (compoundB?.courseNum) {
		const r = await actOpenAssignmentDueInCourse(compoundB);
		await mem.set({ lastHeard: cleaned, lastIntent: "OPEN_ASSIGNMENT_DUE_IN_COURSE" });
		return { intent: "OPEN_ASSIGNMENT_DUE_IN_COURSE", result: { ...r, confidence: 0.95, reason: "compound pre-NLU" } };
	}

	// ✅ intercept course-ish "open ..." BEFORE NLU (your existing logic)
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

	const context = await mem.get();
	const det = await detector(cleaned, context);
	let { intent, slots, confidence, reason } = det || {};
	intent = intent || intents.UNKNOWN;
	slots = slots || {};
	confidence = typeof confidence === "number" ? confidence : 0.25;
	reason = reason || "detector";

	// ✅ Pass utterance into conversational handlers
	if (
		intent === intents.SMALL_TALK ||
		intent === intents.QA_GENERAL ||
		intent === intents.COMPOSE_MESSAGE ||
		intent === intents.ADD_DISCUSSION
	) {
		slots.utterance = cleaned;
	}

	// ✅ If low confidence UNKNOWN, route to QA_GENERAL instead of hard-failing
	// This makes “random thoughts / small questions” work even if phrasing is off.
	if (confidence < 0.45 && intent === intents.UNKNOWN) {
		intent = intents.QA_GENERAL;
		slots = { ...(slots || {}), utterance: cleaned };
		confidence = Math.max(confidence, 0.35);
		reason = `auto-upgrade: unknown->QA_GENERAL (${reason})`;
	}

	// ✅ Keep strict fallback only for non-conversational intents
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
// ✅ Time helpers (America/Chicago safe)
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
	return map; // {year, month, day, hour, minute, second}
}

function getOffsetMs(date, timeZone = USER_TZ) {
	// Convert "what time is it in TZ" into a UTC timestamp and compare with actual UTC time
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

async function actDueToday(slots = {}) {
	const { start, end } = startEndOfToday(USER_TZ);
	const { items } = await collectRelevantItems({
		startISO: start.toISOString(),
		endISO: end.toISOString(),
	});

	const utterance = slots.utterance || "";
	let due = sortByDue(filterItemsByRange(items, start, end));

	// ✅ Filter to assignments only if user asked “assignments”
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

	// ✅ THIS IS THE EXACT SPOT
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
function isMidnightLabel(label) {
	return /\b12:00\s*AM\b/i.test(String(label || ""));
}

function wantsAssignmentsOnly(utterance) {
	const u = String(utterance || "").toLowerCase();
	// If they say “assignment(s)” we filter. Otherwise (planner question) include all.
	return /\bassignments?\b/.test(u);
}

function isAssignmentItem(it) {
	// normalizeCanvasItem sets `type` sometimes; planner raw has plannable_type
	if (!it) return false;
	if (String(it.type || "").toLowerCase() === "assignment") return true;
	const pt = it.raw?.plannable_type || it.raw?.plannable?.plannable_type;
	return String(pt || "").toLowerCase() === "assignment";
}

async function actOverdue() {
	// Overdue doesn’t need a date range, but Planner gives better coverage if we fetch a reasonable window:
	const { start, end } = rangeNextDays(60, USER_TZ);
	const { items } = await collectRelevantItems({
		startISO: start.toISOString(),
		endISO: end.toISOString(),
	});

	const overdue = sortByDue(filterOverdue(items, new Date()));
	// If there are many, only speak the first few
	return await speakSmartAnswer({ question: "Do I have any overdue assignments?", items: overdue.slice(0, 8) });
}
async function actGeneralQA(utterance) {
	const state = await mem.get();
	const u = normalize(utterance || "");

	// ------------------------------------------------------------------
	// Deterministic: date / time / “today”
	// ------------------------------------------------------------------

	// “what’s today”, “what day is it”, “today’s date”
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

	// Time
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
			{ mode: "say" },
		);
		return { ok: true, message: "Explained capabilities" };
	}

	// ------------------------------------------------------------------
	// LLM chat (optional)
	// ------------------------------------------------------------------
	try {
		const reply = await llmChatGeneral({
			utterance,
			context: {
				lastIntent: state.lastIntent,
				activeCourseName: state.activeCourseName,
			},
			maxSentences: 2,
		});

		if (reply && reply.trim()) {
			await speak(reply.trim(), { mode: "say" });
			return { ok: true, message: "QA_GENERAL answered (LLM)" };
		}
	} catch (e) {
		console.warn("[actGeneralQA] LLM failed:", e);
	}

	// Fallback
	await speak(
		"I can help with Canvas. Try: what assignments are due today, what’s due this week, open courses, open assignments, or open grades.",
		{ mode: "say" },
	);

	return { ok: true, message: "QA_GENERAL fallback" };
}
function wait(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCanvasInboxPage() {
	return /\/conversations\b/i.test(window.location.pathname) || /conversations/i.test(window.location.href);
}

function isCanvasAnnouncementsPage() {
	return /\/announcements\b/i.test(window.location.pathname) || /announcements/i.test(window.location.href);
}

function hasAnnouncementKeyword(text) {
	return /\b(announcement|announcements|annoucement|annoucements|announcemnet|announcemnets)\b/i.test(
		String(text || ""),
	);
}

function normalizeAnnouncementTitle(text) {
	return String(text || "")
		.replace(/^unread,\s*/i, "")
		.replace(/\s+/g, " ")
		.trim();
}

function parseRgbColor(colorText) {
	const m = String(colorText || "").match(/rgba?\(\s*(\d{1,3})\D+(\d{1,3})\D+(\d{1,3})/i);
	if (!m) return null;
	return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
}

function isGreenish(colorText) {
	const rgb = parseRgbColor(colorText);
	if (!rgb) return false;
	return rgb.g >= 90 && rgb.g >= rgb.r + 20 && rgb.g >= rgb.b + 20;
}

function hasUnreadGreenDot(row) {
	if (!row) return false;
	const dots = Array.from(row.querySelectorAll("span, div, i")).filter((el) => {
		if (!isVisible(el)) return false;
		const txt = String(el.textContent || "").trim();
		if (txt) return false;
		const r = el.getBoundingClientRect?.();
		if (!r) return false;
		return r.width <= 18 && r.height <= 18 && r.width >= 4 && r.height >= 4;
	});

	return dots.some((el) => {
		const cs = window.getComputedStyle(el);
		const bg = cs.backgroundColor || "";
		const border = cs.borderColor || "";
		const cls = String(el.className || "");
		if (/\binlineBlock-badge\b/i.test(cls)) return true;
		if (isGreenish(bg) || isGreenish(border)) return true;
		return false;
	});
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
		if (/^hello everyone[,!]?$/i.test(t)) continue;
		if (/^hi everyone[,!]?$/i.test(t)) continue;
		if (t.length < 4) continue;
		return t;
	}
	return "";
}

function collectAnnouncementRows() {
	const items = [];
	const byKey = new Map();
	const anchors = Array.from(document.querySelectorAll("a[href*='/announcements/']"));
	const headingNodes = Array.from(document.querySelectorAll("h3.css-cv5a3j-view-heading, h3[dir='auto']"));
	const rowNodes = Array.from(
		document.querySelectorAll(
			".ic-announcement-row, [class*='announcement-row' i], [data-testid*='announcement' i], li, article, section",
		),
	).filter((row) => {
		if (!isVisible(row)) return false;
		const t = String(row.innerText || "").toLowerCase();
		return (
			/\bposted on\b/.test(t) || /\ball sections\b/.test(t) || /\/announcements\//.test(String(row.innerHTML || ""))
		);
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

		const rowText = String(row?.innerText || row?.textContent || "")
			.replace(/\s+/g, " ")
			.trim();
		const rowClass = String(row?.className || "");
		const nodeClass = String(node?.className || "");
		const rowTitle = String(row?.getAttribute?.("title") || "");
		const nodeTitle = String(node?.getAttribute?.("title") || "");

		const hasUnreadBadge = !!row?.querySelector?.(
			"[data-testid='unread-badge'], [data-testid*='unread' i], [aria-label*='unread' i], [title*='unread' i], .unread, .ic-unread-badge, .discussion-unread-icon, .read-state.unread",
		);
		const hasUnreadCueText =
			/\bunread\b/i.test(rowText) || /\bunread\b/i.test(rowTitle) || /\bunread\b/i.test(nodeTitle);
		const hasUnreadCueClass = /\bunread\b/i.test(rowClass) || /\bunread\b/i.test(nodeClass);
		const isUnread =
			/^unread,\s*/i.test(raw) || hasUnreadBadge || hasUnreadCueText || hasUnreadCueClass || hasUnreadGreenDot(row);

		const next = {
			title,
			rawTitle: raw,
			isUnread,
			row,
			link: linkNode || row?.querySelector?.("a[href*='/announcements/']") || null,
			url: linkNode?.href || row?.querySelector?.("a[href*='/announcements/']")?.href || "",
		};

		const prev = byKey.get(key);
		if (prev) {
			// Keep the same title key but preserve unread if any duplicate is marked unread.
			prev.isUnread = prev.isUnread || next.isUnread;
			if (!prev.link && next.link) prev.link = next.link;
			if (!prev.row && next.row) prev.row = next.row;
			if (/^unread,\s*/i.test(next.rawTitle) && !/^unread,\s*/i.test(prev.rawTitle)) {
				prev.rawTitle = next.rawTitle;
			}
			return;
		}

		byKey.set(key, next);
		items.push(next);
	};

	for (const a of anchors) {
		const heading = a.querySelector("h1, h2, h3, h4") || a;
		pushItem(heading, a);
	}
	for (const h of headingNodes) {
		pushItem(h, h.closest?.("a[href*='/announcements/']") || null);
	}
	for (const row of rowNodes) {
		const title = extractAnnouncementTitleFromRow(row);
		if (!title) continue;
		const link = row.querySelector("a[href*='/announcements/']") || null;
		pushItem(link || row, link, row, title);
	}

	return items;
}

function isUnreadAnnouncementTitlesCommand(text) {
	const u = String(text || "").toLowerCase();
	if (!hasAnnouncementKeyword(u)) return false;
	const asksUnread = /\bunread\b/.test(u);
	const asksRead = /\b(read|list|show|tell)\b/.test(u);
	const asksTitles = /\btitles?\b/.test(u);
	return asksUnread && asksRead && (asksTitles || /\bannoun?cements?\b/.test(u));
}

function isReadOpenAnnouncementCommand(text) {
	const u = String(text || "").toLowerCase();
	if (!/\b(read|open)\b/.test(u)) return false;
	if (hasAnnouncementKeyword(u)) return true;
	// Support: open "Information about Exam I" on announcements page.
	if (/["“'][^"”']+["”']/.test(String(text || ""))) return true;
	return false;
}

function isRecentAnnouncementTitlesCommand(text) {
	const u = String(text || "").toLowerCase();
	if (!hasAnnouncementKeyword(u)) return false;
	if (!/\b(read|list|show|tell)\b/.test(u)) return false;
	return /\b(recent|latest|newest|last)\b/.test(u);
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

function mapTitlesToAnnouncementRows(rows, titles) {
	const out = [];
	const used = new Set();
	for (const title of titles || []) {
		const target = findAnnouncementByTitle(
			(rows || []).filter((r) => !used.has(normalizeChoiceText(r.title))),
			title,
		);
		if (!target) continue;
		const k = normalizeChoiceText(target.title);
		if (k && !used.has(k)) {
			used.add(k);
			out.push(target);
		}
	}
	return out;
}

function mapStoredItemsToTargets(items) {
	return (items || [])
		.map((x) => ({
			title: String(x?.title || "").trim(),
			url: String(x?.url || "").trim(),
			row: null,
			link: null,
			bodyHint: String(x?.bodyHint || "").trim(),
			isUnread: false,
		}))
		.filter((x) => x.title);
}

function buildAnnouncementAssistState({ listedItems = [], unreadItems = [] } = {}) {
	const list = listedItems || [];
	const unread = unreadItems || [];
	return {
		awaitingPick: true,
		unreadTitles: unread.map((x) => x.title),
		lastListedTitles: list.map((x) => x.title),
		lastListedItems: list.map((x) => ({
			title: x.title,
			url: x.url || x.link?.href || "",
			bodyHint: extractAnnouncementBodyText(x.row || null),
		})),
		listPath: String(window.location.pathname || ""),
		updatedAt: Date.now(),
	};
}

function extractAnnouncementBodyText(root) {
	if (!root) return "";
	const bodyNode =
		root.querySelector?.(
			"[data-testid='announcement-content'], .ic-Announcement__content, .ic-announcement-row__content.user_content.enhanced, .ic-announcement-row__content, .user_content.enhanced, .user_content",
		) || root;
	const text = String(bodyNode?.innerText || bodyNode?.textContent || "")
		.replace(/\r/g, "")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/\s+/g, " ")
		.trim();
	return text;
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
		await wait(ms);
		detail = readCurrentAnnouncementDetail(fallback);
		if (detail?.body) return detail;
	}
	return detail;
}

let _pendingAnnouncementResumeTimer = null;
let _pendingAnnouncementResumeRunning = false;

function isLikelyAnnouncementDetailPage() {
	const path = String(window.location.pathname || "");
	if (/\/announcements\/\d+/i.test(path)) return true;
	// Strict fallback for Canvas variants that may not include numeric IDs in path.
	// Treat as detail only when explicit announcement detail containers exist,
	// and not when multiple announcement rows are visible.
	const hasExplicitDetail = !!document.querySelector(
		"[data-testid='announcement-content'], .ic-Announcement__content, .announcement_details, .show-content.user_content",
	);
	const rowCount = document.querySelectorAll(".ic-announcement-row, [class*='announcement-row' i]").length;
	return hasExplicitDetail && rowCount <= 1;
}

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
		const sourceUrl = String(pending.sourceUrl || "");
		const urlChanged = !!sourceUrl && sourceUrl !== String(window.location.href || "");
		const fallbackBody = String(pending.bodyHint || "").trim();

		// Deterministic fallback: once navigation/state changes after "open announcement",
		// read cached row content so the user always hears the selected announcement.
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
			}, 550);
			return;
		}

		const detail = await readCurrentAnnouncementDetailWithRetry({ title: pending.title || "" });
		if (!detail?.body || detail.body.length < 30) {
			// If we have the row content hint and we're already on the chosen announcement page,
			// read it immediately so user always hears the announcement after opening.
			if (fallbackBody.length >= 40 && isLikelyAnnouncementDetailPage()) {
				const fallbackTitle = pending.title || "Announcement";
				await speak(`Opening announcement. ${fallbackTitle}.`, { mode: "say" });
				await speakAnnouncementBodyFull(fallbackBody);
				await mem.set({ pendingAnnouncementRead: null });
				return;
			}
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
	const row = target.row || null;

	if (target.link && isVisible(target.link)) {
		target.link.click();
		return true;
	}

	const candidates = [
		row?.querySelector?.("a[href*='/announcements/']"),
		row?.querySelector?.("h1, h2, h3, h4"),
		row?.querySelector?.("[role='link'], [role='button'], a, button"),
	].filter(Boolean);

	for (const el of candidates) {
		try {
			if (!isVisible(el)) continue;
			el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
			el.click?.();
			el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
			return true;
		} catch {}
	}

	if (row) {
		try {
			row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
			row.click?.();
			row.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
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
		},
	});
	clickAnnouncementTarget(target);

	await wait(550);
	const detail = await readCurrentAnnouncementDetailWithRetry(target);
	const onDetailPage = /\/announcements\/\d+/i.test(window.location.pathname);
	const title = detail?.title || target.title || "Announcement";
	const looksListHeading = /^announcements?$/i.test(String(title || "").trim());

	// Speak immediately only when we're clearly on a detail page with real body text.
	if (onDetailPage && detail?.body && !looksListHeading) {
		const prefix = label ? `Opening announcement ${label}.` : "Opening announcement.";
		await speak(`${prefix} ${title}.`, { mode: "say" });
		await speakAnnouncementBodyFull(detail.body);
		await mem.set({ pendingAnnouncementRead: null });
		return { ok: true, message: "Opened and read announcement" };
	}

	// Navigation likely in progress; resumePendingAnnouncementRead will read on the destination page.
	return { ok: true, message: "Announcement opening; awaiting destination page read" };
}

async function maybeHandleAnnouncementAssist(utterance) {
	if (!isCanvasAnnouncementsPage()) return null;

	const u = String(utterance || "").trim();
	const lower = u.toLowerCase();
	const state = await mem.get();
	const assist = state.announcementAssist || {};

	const rows = collectAnnouncementRows();
	const unread = rows.filter((x) => x.isUnread);

	if (isUnreadAnnouncementTitlesCommand(u)) {
		await mem.set({ pendingAnnouncementRead: null });
		if (!unread.length) {
			await mem.set({ announcementAssist: null });
			await speak("You have no unread announcements right now.", { mode: "say" });
			return { intent: "ANNOUNCEMENT_READ", result: { ok: true, message: "No unread announcements" } };
		}

		const maxSpeak = Math.min(unread.length, 8);
		const titlesLine = unread
			.slice(0, maxSpeak)
			.map((x, i) => `${i + 1}: ${x.title}`)
			.join(". ");
		const moreLine = unread.length > maxSpeak ? ` I found ${unread.length} total unread announcements.` : "";

		await mem.set({
			announcementAssist: {
				...buildAnnouncementAssistState({ listedItems: unread, unreadItems: unread }),
				lastListType: "unread",
			},
		});

		await speak(`You have ${unread.length} unread announcements.${moreLine} ${titlesLine}`, {
			raw: true,
			mode: "read",
		});
		return { intent: "ANNOUNCEMENT_READ", result: { ok: true, message: "Read unread announcement titles" } };
	}

	if (isRecentAnnouncementTitlesCommand(u)) {
		await mem.set({ pendingAnnouncementRead: null });
		if (!rows.length) {
			await mem.set({ announcementAssist: null });
			await speak("I can't find announcements on this page right now.", { mode: "say" });
			return { intent: "ANNOUNCEMENT_READ", result: { ok: false, message: "No announcements found" } };
		}
		const recent = rows.slice(0, 3);
		const titlesLine = recent.map((x, i) => `${i + 1}: ${x.title}`).join(". ");
		await mem.set({
			announcementAssist: {
				...buildAnnouncementAssistState({ listedItems: recent, unreadItems: unread }),
				lastListType: "recent",
			},
		});
		await speak(`Here are the 3 most recent announcements. ${titlesLine}`, { raw: true, mode: "read" });
		return { intent: "ANNOUNCEMENT_READ", result: { ok: true, message: "Read recent announcement titles" } };
	}

	// Context follow-up: after listing announcement titles, allow "read <title>" without saying "announcement".
	if (assist?.awaitingPick && /\b(read|open)\b/.test(lower)) {
		const listTitles = Array.isArray(assist.lastListedTitles) ? assist.lastListedTitles : [];
		const listItems = Array.isArray(assist.lastListedItems) ? assist.lastListedItems : [];
		const candidateRows = listTitles.length ? mapTitlesToAnnouncementRows(rows, listTitles) : rows;
		const storedRows = mapStoredItemsToTargets(listItems);
		const candidates = candidateRows.length ? candidateRows : rows.length ? rows : storedRows;
		const titleQueryFromFollowup = extractAnnouncementTitleQuery(u);
		if (titleQueryFromFollowup) {
			const target = findAnnouncementByTitle(candidates, titleQueryFromFollowup);
			if (target) {
				const res = await openAndReadAnnouncement(target);
				return { intent: intents.QA_GENERAL, result: res };
			}
		}
	}

	// Direct title read/open on announcements page even without saying the word "announcement".
	if (/^\s*(read|open)\b/.test(lower)) {
		const directTitleQuery = extractAnnouncementTitleQuery(u);
		if (directTitleQuery) {
			const storedRows = mapStoredItemsToTargets(Array.isArray(assist.lastListedItems) ? assist.lastListedItems : []);
			const target = findAnnouncementByTitle(rows.length ? rows : storedRows, directTitleQuery);
			if (target) {
				const res = await openAndReadAnnouncement(target);
				return { intent: intents.QA_GENERAL, result: res };
			}
		}
	}

	// On an opened announcement detail page, treat any "read/open <text>" as announcement read,
	// even if the utterance omits the word "announcement".
	if (/^\s*(read|open)\b/.test(lower) && !rows.length && isLikelyAnnouncementDetailPage()) {
		const detail = await readCurrentAnnouncementDetailWithRetry(null);
		const title = detail?.title || "Announcement";
		await speak(`Opening announcement. ${title}.`, { mode: "say" });
		if (detail?.body) {
			await speakAnnouncementBodyFull(detail.body);
			return { intent: intents.QA_GENERAL, result: { ok: true, message: "Read current announcement detail" } };
		}
		return { intent: intents.QA_GENERAL, result: { ok: false, message: "Current announcement body missing" } };
	}

	if (!isReadOpenAnnouncementCommand(lower)) return null;

	// If we're already on a single announcement detail page, read it directly.
	if (!rows.length && /\/announcements\/\d+/i.test(window.location.pathname)) {
		const detail = await readCurrentAnnouncementDetailWithRetry(null);
		const title = detail?.title || "Announcement";
		await speak(`Opening announcement. ${title}.`, { mode: "say" });
		if (detail?.body) {
			await speakAnnouncementBodyFull(detail.body);
			return { intent: intents.QA_GENERAL, result: { ok: true, message: "Read current announcement detail" } };
		}
		await speak("I opened it, but I could not read the full content yet.", { mode: "say" });
		return { intent: intents.QA_GENERAL, result: { ok: false, message: "Current announcement body missing" } };
	}

	const idx = readAnnouncementIndexFromUtterance(lower);
	if (idx != null) {
		const listTitles = Array.isArray(assist.lastListedTitles) ? assist.lastListedTitles : [];
		const listItems = Array.isArray(assist.lastListedItems) ? assist.lastListedItems : [];
		const sameListPath = String(assist.listPath || "") === String(window.location.pathname || "");
		const pickedList = sameListPath && listTitles.length ? mapTitlesToAnnouncementRows(rows, listTitles) : [];
		const storedList = mapStoredItemsToTargets(listItems);
		let base = pickedList.length ? pickedList : rows.length ? rows : storedList;
		if (idx >= base.length) {
			base = rows.length ? rows : storedList;
		}

		if (!base.length) {
			await speak("I can't find announcements on this page right now.", { mode: "say" });
			return { intent: intents.QA_GENERAL, result: { ok: false, message: "No announcements found" } };
		}
		if (idx < 0 || idx >= base.length) {
			await speak(`Please say a number between 1 and ${Math.min(base.length, 10)}.`, { mode: "say" });
			return { intent: intents.QA_GENERAL, result: { ok: false, message: "Announcement index out of range" } };
		}
		const res = await openAndReadAnnouncement(base[idx], String(idx + 1));
		return { intent: intents.QA_GENERAL, result: res };
	}

	const titleQuery = extractAnnouncementTitleQuery(u);
	if (titleQuery) {
		const target = findAnnouncementByTitle(rows, titleQuery);
		if (!target) {
			await speak("I couldn't find an announcement with that title. Please say it again or use announcement number.", {
				mode: "say",
			});
			return { intent: intents.QA_GENERAL, result: { ok: false, message: "Announcement title not found" } };
		}
		const res = await openAndReadAnnouncement(target);
		return { intent: intents.QA_GENERAL, result: res };
	}

	// "read this announcement" while already on detail/list page
	const res = await openAndReadAnnouncement(rows[0] || null);
	return { intent: intents.QA_GENERAL, result: res };
}

function isVisible(el) {
	if (!el) return false;
	const style = window.getComputedStyle(el);
	if (style.display === "none" || style.visibility === "hidden") return false;
	const rect = el.getBoundingClientRect();
	return rect.width > 0 && rect.height > 0;
}

function findVisibleButtonByText(re, root = document) {
	const buttons = Array.from(root.querySelectorAll("button, [role='button']"));
	return buttons.find((btn) => isVisible(btn) && re.test((btn.textContent || "").trim())) || null;
}

function firstMatch(selectors, root = document) {
	for (const sel of selectors) {
		const el = root.querySelector(sel);
		if (el && isVisible(el)) return el;
	}
	return null;
}

function getComposeRoot() {
	const dialog = Array.from(document.querySelectorAll("[role='dialog']")).find((el) => {
		const t = (el.textContent || "").toLowerCase();
		return t.includes("compose") || t.includes("message");
	});
	return dialog || document;
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

function looksLikeComposeTrigger(text) {
	const lower = String(text || "").toLowerCase();
	return (
		/\b(compose|write|create)\b.*\b(message|email|inbox)\b/.test(lower) ||
		/\bnew message\b/.test(lower) ||
		/\bstart compose\b/.test(lower)
	);
}

function looksLikeDiscussionTrigger(text) {
	const lower = String(text || "").toLowerCase();
	return (
		/\b(add|create|new|start)\b.*\bdiscussion\b/.test(lower) || /\bdiscussion\b.*\b(add|create|new|start)\b/.test(lower)
	);
}

function parseYesNo(text) {
	const t = String(text || "").toLowerCase();
	if (/\b(yes|yeah|yep|sure|ok|okay|do it|please do)\b/.test(t)) return true;
	if (/\b(no|nope|nah|dont|don’t|do not|stop|not now)\b/.test(t)) return false;
	return null;
}

function isDiscussionNewPage() {
	const path = String(window.location.pathname || "");
	if (/\/discussion_topics\/new\b/i.test(path)) return true;
	const titleField = firstMatch(
		["input[name='title']", "input#discussion_title", "input[placeholder*='topic title' i]"],
		document,
	);
	return !!titleField;
}

function getDiscussionTitleInput() {
	return (
		firstMatch(
			[
				"input#discussion_title",
				"input[name='title']",
				"input[placeholder*='topic title' i]",
				"input[aria-label*='topic title' i]",
			],
			document,
		) || null
	);
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
			document,
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

	const field = getDiscussionContentEditable();
	if (!field) return false;
	return writeField(field, value);
}

function findLabelCheckbox(labelPattern) {
	const labels = Array.from(document.querySelectorAll("label"));
	for (const label of labels) {
		const txt = String(label.textContent || "")
			.replace(/\s+/g, " ")
			.trim();
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
		const txt = String(w.textContent || "")
			.replace(/\s+/g, " ")
			.trim();
		if (!labelPattern.test(txt)) continue;
		const cb = w.querySelector("input[type='checkbox']");
		if (cb) return cb;
	}
	return null;
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

function findDiscussionSubmitButton() {
	const buttons = Array.from(document.querySelectorAll("button, [role='button']")).filter(isVisible);
	const exact = buttons.find((btn) =>
		/^(submit|save|add discussion|save and publish|post to discussion)$/i.test((btn.textContent || "").trim()),
	);
	if (exact) return exact;

	const fallback = buttons.find((btn) =>
		/\b(submit|save|publish|add discussion)\b/i.test((btn.textContent || "").trim()),
	);
	return fallback || null;
}

function findAddDiscussionControl() {
	const preferred = findVisibleButtonByText(/\badd discussion\b/i, document);
	if (preferred) return preferred;

	const links = Array.from(document.querySelectorAll("a[href*='/discussion_topics/new'], button, [role='button']"))
		.filter(isVisible)
		.sort((a, b) => {
			const at = String(a.textContent || "").toLowerCase();
			const bt = String(b.textContent || "").toLowerCase();
			const as = at.includes("add discussion") ? 2 : at.includes("discussion") ? 1 : 0;
			const bs = bt.includes("add discussion") ? 2 : bt.includes("discussion") ? 1 : 0;
			return bs - as;
		});
	return links[0] || null;
}

async function openDiscussionComposer() {
	if (isDiscussionNewPage()) return true;

	const add = findAddDiscussionControl();
	if (add) {
		add.focus?.();
		add.click?.();
		await wait(300);
		const ready = await waitFor(() => isDiscussionNewPage(), { timeoutMs: 4500, stepMs: 150 });
		if (ready) return true;
	}

	const path = String(window.location.pathname || "");
	if (/\/discussion_topics\b/i.test(path) && !/\/discussion_topics\/new\b/i.test(path)) {
		window.location.href = `${window.location.origin}${path.replace(/\/$/, "")}/new`;
		return false;
	}
	return isDiscussionNewPage();
}

function discussionPromptForStep(step) {
	switch (step) {
		case "title":
			return "What would you want as a topic title?";
		case "content":
			return "Please speak out the topic content.";
		case "require_before_reply":
			return "Participants must respond to the topic before viewing other replies. Do you want this option? Say yes or no.";
		case "allow_liking":
			return "Allow liking. Do you want this option? Say yes or no.";
		case "confirm_submit":
			return "Would you like to submit? Say yes or no.";
		default:
			return "";
	}
}

async function clearDiscussionWizardState() {
	await mem.set({ discussionWizard: null });
}

async function promptDiscussionStep(wizard, { force = false } = {}) {
	if (!wizard?.active) return;
	const key = `${wizard.step}@${window.location.pathname}`;
	const lastAt = Number(wizard.lastPromptAt || 0);
	if (!force && wizard.lastPromptKey === key && Date.now() - lastAt < 7000) return;
	const msg = discussionPromptForStep(wizard.step);
	if (!msg) return;
	await speak(msg, { mode: "say" });
	await mem.set({
		discussionWizard: {
			...wizard,
			lastPromptKey: key,
			lastPromptAt: Date.now(),
		},
	});
}

async function startDiscussionWizard() {
	const opened = await openDiscussionComposer();
	const wizard = {
		active: true,
		step: "title",
		title: "",
		content: "",
		respondBeforeReplies: null,
		allowLiking: null,
		lastPromptKey: "",
		lastPromptAt: 0,
		autoPromptBlockedUntil: Date.now() + 5000,
	};
	await mem.set({ discussionWizard: wizard });

	if (!opened) {
		await speak("Opening add discussion. I will ask for details as soon as the form is ready.", { mode: "say" });
		return { ok: true, message: "Discussion form opening" };
	}

	await promptDiscussionStep(wizard, { force: true });
	return { ok: true, message: "Discussion wizard started" };
}

async function resumePendingDiscussionWizard() {
	const st = await mem.get();
	const wizard = st?.discussionWizard;
	if (!wizard?.active) return;
	if (!isDiscussionNewPage()) return;
	if (Date.now() < Number(wizard.autoPromptBlockedUntil || 0)) return;
	await promptDiscussionStep(wizard);
}

function isCourseLikeText(text) {
	return /\b(?:csce|cse|csc|math|engl|hist|phys|chem|bio|course)\b/i.test(String(text || ""));
}

function scoreCourseSelectCandidate(sel) {
	if (!sel) return 0;
	const idName = `${sel.id || ""} ${sel.name || ""} ${sel.getAttribute?.("aria-label") || ""}`.toLowerCase();
	const options = Array.from(sel.options || []);
	let score = 0;

	if (/\bcourse\b/.test(idName)) score += 5;
	if (options.length >= 3) score += 1;

	for (const o of options) {
		const text = String(o.textContent || "").trim();
		const value = String(o.value || "").trim();
		const combo = `${text} ${value}`.toLowerCase();
		if (combo.includes("course_")) score += 4;
		if (/\bcourse\b/.test(combo)) score += 2;
		if (/[a-z]{2,5}\s*\d{3,4}/i.test(text)) score += 2;
		if (isCourseLikeText(text)) score += 1;
	}

	return score;
}

function getSelectCandidates(root) {
	const merged = [...root.querySelectorAll("select"), ...document.querySelectorAll("select")];
	return Array.from(new Set(merged));
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
	// Canvas comboboxes often open on ArrowDown.
	fireKey(cb, "ArrowDown");
	return true;
}

function tryOpenCoursePicker() {
	if (openCourseCombobox()) return true;

	const { courseSelect } = getComposeElements();
	if (courseSelect) {
		courseSelect.focus?.();
		courseSelect.click?.();
		courseSelect.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
		return true;
	}

	const root = getComposeRoot();
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
		directCourseTrigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
		return true;
	}

	const candidates = Array.from(
		root.querySelectorAll("button, [role='button'], [role='combobox'], input, [data-testid], [aria-label]"),
	).filter(isVisible);

	const trigger = candidates.find((el) => {
		const blob =
			`${el.textContent || ""} ${el.getAttribute?.("aria-label") || ""} ${el.id || ""} ${el.getAttribute?.("name") || ""}`.toLowerCase();
		return blob.includes("course");
	});

	if (trigger) {
		trigger.focus?.();
		trigger.click?.();
		trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
		return true;
	}

	return false;
}

function getComposeElements() {
	const dialog = getComposeDialog();
	if (!dialog) {
		return {
			recipient: null,
			subject: null,
			body: null,
			sendButton: null,
			cancelButton: null,
			courseSelect: null,
			recipientTypeSelect: null,
		};
	}
	const root = dialog;
	const selects = getSelectCandidates(root);
	const courseSelect =
		selects
			.map((sel) => ({ sel, score: scoreCourseSelectCandidate(sel) }))
			.sort((a, b) => b.score - a.score)
			.find((x) => x.score >= 4)?.sel || null;
	const recipientTypeSelect =
		selects.find((sel) => {
			const vals = Array.from(sel.options).map((o) => (o.textContent || "").trim().toLowerCase());
			return vals.includes("courses") || vals.includes("course") || vals.includes("users") || vals.includes("user");
		}) || null;

	let recipient = firstMatch(
		[
			"input[aria-label*='recipient' i]",
			"input[placeholder*='recipient' i]",
			"input[aria-label*='to' i]",
			"input[placeholder='To']",
			"input[placeholder*='to' i]",
			"input[role='combobox']",
			"[role='combobox'] input",
			"[contenteditable='true'][aria-label*='to' i]",
		],
		root,
	);

	const subject = firstMatch(
		["input[aria-label*='subject' i]", "input[name*='subject' i]", "input[placeholder*='subject' i]"],
		root,
	);

	let body = firstMatch(
		[
			"textarea[aria-label*='message' i]",
			"textarea[placeholder*='message' i]",
			"textarea",
			"[contenteditable='true'][aria-label*='message' i]",
			"[role='textbox'][contenteditable='true']",
			"[contenteditable='true']",
		],
		root,
	);

	const sendButton = findVisibleButtonByText(/\bsend\b/i, root) || firstMatch(["button[data-testid*='send' i]"], root);
	const cancelButton =
		findVisibleButtonByText(/\b(cancel|discard)\b/i, root) ||
		firstMatch(["button[data-testid*='close' i]", "button[aria-label*='close' i]"], root);

	if (body && recipient && body === recipient) body = null;
	if (!recipient) recipient = firstMatch(["input"], root);

	return { recipient, subject, body, sendButton, cancelButton, courseSelect, recipientTypeSelect };
}

function writeField(el, text, { append = false } = {}) {
	if (!el) return false;
	const value = String(text || "").trim();
	if (!value) return false;

	el.focus?.();

	if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
		const existing = String(el.value || "");
		el.value = append && existing ? `${existing} ${value}` : value;
		el.dispatchEvent(new Event("input", { bubbles: true }));
		el.dispatchEvent(new Event("change", { bubbles: true }));
		return true;
	}

	if (el.isContentEditable) {
		const existing = String(el.textContent || "");
		el.textContent = append && existing ? `${existing} ${value}` : value;
		el.dispatchEvent(new Event("input", { bubbles: true }));
		return true;
	}

	return false;
}

function clearComposeWizardState() {
	return mem.set({ composeWizard: null });
}

function cleanUtterancePayload(utterance, patterns = []) {
	let t = String(utterance || "").trim();
	for (const re of patterns) t = t.replace(re, "").trim();
	return t;
}

function wantsOptionList(text) {
	const u = String(text || "").toLowerCase();
	return /\b(list|show|read|tell)\b.*\b(options?|choices?)\b/.test(u) || /\bwhat are my options\b/.test(u);
}

function isInboxReadCommand(text) {
	const u = String(text || "").toLowerCase();
	return /\b(read|check|summarize|list|show)\b/.test(u) && (/\binbox\b/.test(u) || /\bunread\b/.test(u));
}

function isReadNthMessageCommand(text) {
	const u = String(text || "").toLowerCase();
	return (
		/\b(read|open)\b/.test(u) && /\b(first|second|third|fourth|fifth|\d+)\b/.test(u) && /\b(email|message)\b/.test(u)
	);
}

function isReadLatestMessageCommand(text) {
	const u = String(text || "").toLowerCase();
	return /\b(read|open)\b/.test(u) && /\b(latest|last|newest|most recent)\b/.test(u) && /\b(email|message)\b/.test(u);
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

function extractNumberTokens(s) {
	return new Set((String(s || "").match(/\b\d+\b/g) || []).map((x) => x.trim()));
}

function scoreOptionForUtterance(optionLabel, utterance, mode = "generic") {
	const normalized = mode === "course" ? normalizeCourseLabelText(utterance) : normalizeChoiceText(utterance);
	const tokens = normalized.split(" ").filter((t) => t.length > 2);
	const utterNumTokens = extractNumberTokens(normalized);
	const utterHasCapstone = /\bcapstone\b/.test(normalized);
	const utterHasNetwork = /\bnetwork\b/.test(normalized);

	const label = mode === "course" ? normalizeCourseLabelText(optionLabel) : normalizeChoiceText(optionLabel);
	if (!label) return Number.NEGATIVE_INFINITY;

	let score = 0;
	if (label === normalized) score += 100;
	if (label.includes(normalized) && normalized) score += 12;
	for (const tok of tokens) if (label.includes(tok)) score += 3;

	if (mode === "course") {
		const labelNums = extractNumberTokens(label);
		if (utterNumTokens.size) {
			let matchedAnyNum = false;
			for (const n of utterNumTokens) {
				if (labelNums.has(n)) {
					score += 8;
					matchedAnyNum = true;
				}
			}
			if (!matchedAnyNum) score -= 12;
		}

		if (utterHasCapstone && !/\bcapstone\b/.test(label)) score -= 10;
		if (utterHasNetwork && !/\bnetwork\b/.test(label)) score -= 8;
	}

	return score;
}

function rankedOptionsByUtterance(options, utterance, mode = "generic") {
	return (options || [])
		.map((opt) => ({ ...opt, __score: scoreOptionForUtterance(opt.label, utterance, mode) }))
		.sort((a, b) => b.__score - a.__score);
}

function shouldDisambiguateCourse(utterance, ranked) {
	if (!ranked || ranked.length < 2) return false;
	const top = ranked[0];
	const second = ranked[1];
	if (!top || !second) return false;

	const u = normalizeCourseLabelText(utterance);
	const isShortQuery = u.split(" ").filter(Boolean).length <= 2 || u.length <= 8;
	const closeScores = top.__score - second.__score <= 3;
	const topPositive = top.__score > 0 && second.__score > 0;
	const topLabel = normalizeCourseLabelText(top.label);
	const secondLabel = normalizeCourseLabelText(second.label);
	const overlap = topLabel.includes(secondLabel) || secondLabel.includes(topLabel) || /\bai\b/.test(u);

	return topPositive && closeScores && (isShortQuery || overlap);
}

function shouldDisambiguateRecipient(utterance, ranked) {
	if (!ranked || ranked.length < 2) return false;
	const top = ranked[0];
	const second = ranked[1];
	if (!top || !second) return false;
	const u = normalizeChoiceText(utterance);
	const shortQuery = u.split(" ").filter(Boolean).length <= 2;
	const closeScores = top.__score - second.__score <= 2;
	const topPositive = top.__score > 0 && second.__score > 0;
	return topPositive && closeScores && shortQuery;
}

function dedupeOptionsByLabel(options) {
	const out = [];
	const seen = new Set();
	for (const o of options || []) {
		const key = normalizeChoiceText(o.label);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		out.push(o);
	}
	return out;
}

function extractSenderSubjectFromRow(row) {
	const senderSel = row.querySelector(".css-c31sii-text, [data-testid*='participants' i], [data-testid*='sender' i]");
	const subjectSel = row.querySelector(
		".css-cv5a3j-view-heading, [data-testid*='subject' i], [data-testid*='message-title' i]",
	);

	let sender = senderSel?.textContent?.trim() || "";
	let subject = subjectSel?.textContent?.trim() || "";
	if (isBadSubjectText(subject)) subject = "";

	if (!sender || !subject) {
		const lines = String(row.innerText || "")
			.split("\n")
			.map((s) => s.trim())
			.filter(Boolean);
		const filtered = lines.filter((l) => !extractDateLike(l));
		if (!sender) {
			sender =
				filtered.find((l) => isLikelySenderLine(l, subject)) ||
				filtered.find((l) => l.length > 2 && l.length < 120) ||
				"Unknown sender";
		}
		if (!subject) {
			const senderNorm = normalizeChoiceText(sender);
			subject =
				filtered.find((l) => {
					const n = normalizeChoiceText(l);
					if (!n || n === senderNorm) return false;
					if (isBadSubjectText(l)) return false;
					if (isLikelySenderLine(l, "")) return false;
					return l.length > 2 && l.length < 140;
				}) || "No subject";
		}
	}

	const date =
		row.querySelector(".css-1bw2jwe-text, [data-testid*='date' i], [class*='date' i]")?.textContent?.trim() || "";

	const cleanSender = String(sender || "")
		.replace(/\bmessage\b.*\bnot selected\b/gi, "")
		.replace(/\s+/g, " ")
		.trim();
	const cleanSubject = String(subject || "")
		.replace(/\bmessage\b.*\bnot selected\b/gi, "")
		.replace(/\s+/g, " ")
		.trim();

	return {
		sender: cleanSenderName(cleanSender) || "Unknown sender",
		subject: cleanSubject || "No subject",
		date: date || "",
	};
}

function collectUnreadInboxRows() {
	const rows = Array.from(
		document.querySelectorAll("[data-testid='conversationListItem-Item'], [data-testid*='conversationListItem' i]"),
	).filter(isVisible);

	const unreadRows = rows.filter((row) => {
		return !!row.querySelector(
			"[data-testid='unread-badge'], [data-testid*='unread' i], [aria-label*='unread' i], .unread, .ic-unread-badge",
		);
	});

	return unreadRows.map((row) => {
		const { sender, subject, date } = extractSenderSubjectFromRow(row);
		return { row, sender, subject, date };
	});
}

function collectInboxRows() {
	const rows = Array.from(
		document.querySelectorAll("[data-testid='conversationListItem-Item'], [data-testid*='conversationListItem' i]"),
	).filter(isVisible);

	return rows.map((row) => {
		const { sender, subject, date } = extractSenderSubjectFromRow(row);
		return { row, sender, subject, date };
	});
}

function extractDateLike(text) {
	const s = String(text || "");
	const m = s.match(
		/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+\d{4}(?:\s+at\s+\d{1,2}:\d{2}\s*(?:am|pm))?\b/i,
	);
	return m ? m[0].replace(/\s+/g, " ").trim() : "";
}

function isBadSubjectText(s) {
	const t = String(s || "")
		.trim()
		.toLowerCase();
	if (!t) return true;
	if (/^\d+\s*messages?$/.test(t)) return true;
	if (/message.*not selected/.test(t)) return true;
	if (/^(inbox|all courses|search)$/i.test(t)) return true;
	return false;
}

function cleanSubjectText(subjectText) {
	let s = String(subjectText || "")
		.replace(/\s+/g, " ")
		.trim();
	s = s.replace(/\b(mark\s+as\s+unread|mark\s+as\s+read|reply|forward)\b.*$/i, "").trim();
	return s;
}

function isLikelySenderLine(line, subjectHint = "") {
	const l = String(line || "").trim();
	if (!l) return false;
	const n = normalizeChoiceText(l);
	if (!n) return false;
	if (extractDateLike(l)) return false;
	if (/section\s+\d+/i.test(l)) return false;
	if (isBadSubjectText(l)) return false;
	if (subjectHint && normalizeChoiceText(subjectHint) === n) return false;
	return /,| and | & |[A-Z][a-z]+\s+[A-Z][a-z]+/.test(l);
}

function cleanSenderName(senderText) {
	let s = String(senderText || "")
		.replace(/\s+/g, " ")
		.trim();
	if (!s) return "";
	s = s.replace(/\b\d+\s+more\b/gi, "").trim();
	// Prefer the primary sender if Canvas shows a participant list.
	if (s.includes(",")) s = s.split(",")[0].trim();
	if (/\s+and\s+/i.test(s)) s = s.split(/\s+and\s+/i)[0].trim();
	return s;
}

function isInboxRowElement(el) {
	return !!el?.closest?.("[data-testid='conversationListItem-Item'], [data-testid*='conversationListItem' i]");
}

function isLikelyRightPaneElement(el) {
	if (!el || !isVisible(el) || isInboxRowElement(el)) return false;
	const r = el.getBoundingClientRect?.();
	if (!r) return true;
	return r.left >= window.innerWidth * 0.28 && r.width >= 260 && r.height >= 120;
}

function findOpenedMessagePanel(subjectHint = "") {
	const detailNodes = Array.from(
		document.querySelectorAll(
			".css-103zv00-view-flexItem, [data-testid*='message-detail' i], [class*='message-detail' i], main, [role='main']",
		),
	).filter(isLikelyRightPaneElement);

	const headingNodes = Array.from(
		document.querySelectorAll(
			"[data-testid='message-detail-header-desktop'], [data-testid*='message-detail-header' i], h1, h2, [role='heading']",
		),
	)
		.filter(isLikelyRightPaneElement)
		.filter((h) => {
			const t = (h.textContent || "").trim();
			return t && !isBadSubjectText(t) && normalizeChoiceText(t) !== "inbox";
		});

	const hintNorm = normalizeChoiceText(subjectHint);
	if (hintNorm && headingNodes.length) {
		const scored = headingNodes
			.map((h) => {
				const n = normalizeChoiceText(h.textContent || "");
				let s = 0;
				if (n === hintNorm) s += 12;
				if (n.includes(hintNorm)) s += 8;
				if (hintNorm.includes(n) && n.length > 4) s += 5;
				return { h, s };
			})
			.sort((a, b) => b.s - a.s);
		if (scored[0] && scored[0].s > 0) {
			const h = scored[0].h;
			let panel =
				h.closest(
					".css-103zv00-view-flexItem, [data-testid*='message-detail' i], [class*='message-detail' i], article, section, [role='main'], main",
				) || h.parentElement;
			// Walk up to a richer container that likely includes the body.
			let p = panel?.parentElement || null;
			for (let i = 0; i < 6 && p; i += 1) {
				const txt = (p.innerText || "").trim();
				if (isLikelyRightPaneElement(p) && txt.length > (panel?.innerText || "").length) panel = p;
				p = p.parentElement;
			}
			if (panel && isLikelyRightPaneElement(panel)) return panel;
		}
	}

	if (detailNodes.length) {
		return detailNodes.sort((a, b) => (b.innerText || "").length - (a.innerText || "").length)[0];
	}
	return null;
}

function readCurrentMessageDetail(subjectHint = "") {
	const panel = findOpenedMessagePanel(subjectHint);
	if (!panel) return null;

	let subject =
		panel
			.querySelector("[data-testid='message-detail-header-desktop'], [data-testid*='message-detail-header' i], h1, h2")
			?.textContent?.trim() || "";
	subject = cleanSubjectText(subject);
	if (!subject || isBadSubjectText(subject) || normalizeChoiceText(subject) === "inbox") {
		const heads = Array.from(panel.querySelectorAll("h1, h2, [role='heading']"))
			.map((el) => (el.textContent || "").trim())
			.filter(Boolean);
		const cleanHeads = heads
			.map((h) => cleanSubjectText(h))
			.filter((h) => !isBadSubjectText(h) && normalizeChoiceText(h) !== "inbox");
		subject = cleanHeads[0] || "";
	}
	let sender =
		panel
			.querySelector(
				"span.css-g5lcut-text, [data-testid*='author' i], [class*='author' i], [data-testid*='participants' i]",
			)
			?.textContent?.trim() || "";
	let date = extractDateLike(panel.innerText || "");
	const panelLines = String(panel.innerText || "")
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);

	if (!sender) {
		const lines = panelLines.slice(0, 20);
		const subjNorm = normalizeChoiceText(subject);
		sender =
			lines.find((l) => {
				const n = normalizeChoiceText(l);
				if (!n || n === subjNorm) return false;
				return isLikelySenderLine(l, subject);
			}) || "";
		if (!date) {
			const dateLine = lines.find((l) => !!extractDateLike(l));
			if (dateLine) date = extractDateLike(dateLine);
		}
	}
	sender = cleanSenderName(sender);

	if ((!subject || isBadSubjectText(subject)) && panelLines.length) {
		subject =
			panelLines.find((l0) => {
				const l = cleanSubjectText(l0);
				const n = normalizeChoiceText(l);
				if (!n) return false;
				if (isBadSubjectText(l)) return false;
				if (extractDateLike(l)) return false;
				if (l.length > 140) return false;
				if (isLikelySenderLine(l, "")) return false;
				if (/section\s+\d+/i.test(l)) return false;
				return true;
			}) || subject;
		subject = cleanSubjectText(subject);
	}

	const bodyCandidates = [
		...panel.querySelectorAll("span.css-hszq8y-text"),
		...panel.querySelectorAll("[data-testid*='message-body' i]"),
		...panel.querySelectorAll("[data-testid*='message-content' i]"),
		...panel.querySelectorAll("[class*='message-body' i]"),
		...panel.querySelectorAll(".message, .message-content, .user_content, p"),
	];

	const senderNorm = normalizeChoiceText(sender);
	const subjectNorm = normalizeChoiceText(subject);
	const bodyFromNodes = Array.from(
		new Set(
			bodyCandidates
				.map((el) => (el.textContent || "").trim())
				.filter(Boolean)
				.filter((t) => {
					const n = normalizeChoiceText(t);
					if (!n) return false;
					if (n === subjectNorm) return false;
					if (senderNorm && n === senderNorm) return false;
					if (extractDateLike(t)) return false;
					if (/section\s+\d+/i.test(t)) return false;
					if (/^\d+\s*messages?$/i.test(t)) return false;
					if (/^(inbox|all courses|search|compose|settings)$/i.test(t)) return false;
					return true;
				}),
		),
	).join("\n");

	let bodyText = bodyFromNodes.replace(/\n{3,}/g, "\n\n").trim();
	if (!bodyText || bodyText.length < 20) {
		const lineIsUiNoise = (l) => {
			const n = normalizeChoiceText(l);
			if (!n) return true;
			if (/^(inbox|all courses|search|compose|settings|no conversations selected)$/i.test(l)) return true;
			if (/\bmark as unread\b/i.test(l)) return true;
			if (/\bmark as read\b/i.test(l)) return true;
			if (/^\d+\s*messages?$/i.test(l)) return true;
			return false;
		};
		const dateIdx = panelLines.findIndex((l) => !!extractDateLike(l));
		const subjIdx = panelLines.findIndex((l) => normalizeChoiceText(cleanSubjectText(l)) === subjectNorm);
		const start = Math.max(dateIdx + 1, subjIdx + 1, 0);
		const tail = panelLines.slice(start);
		const fallbackLines = tail.filter((l) => {
			const n = normalizeChoiceText(l);
			if (!n) return false;
			if (n === subjectNorm) return false;
			if (senderNorm && n === senderNorm) return false;
			if (isLikelySenderLine(l, subject)) return false;
			if (extractDateLike(l)) return false;
			if (/section\s+\d+/i.test(l)) return false;
			if (lineIsUiNoise(l)) return false;
			return true;
		});
		bodyText = fallbackLines.slice(0, 40).join(" ").replace(/\s+/g, " ").trim();
	}
	if (!bodyText || bodyText.length < 20) {
		bodyText = fallbackBodyFromRightPaneText(subject, sender, date);
	}

	return {
		subject: subject || "No subject",
		sender: sender || "Unknown sender",
		date: date || "",
		bodyPreview: bodyText ? bodyText.slice(0, 4000) : "",
	};
}

function fallbackBodyFromRightPaneText(subject, sender, date) {
	const nodes = Array.from(document.querySelectorAll("article, section, main, [role='main'], div"))
		.filter(isLikelyRightPaneElement)
		.filter((el) => (el.innerText || "").trim().length > 80)
		.sort((a, b) => (b.innerText || "").length - (a.innerText || "").length)
		.slice(0, 8);

	const subjectNorm = normalizeChoiceText(cleanSubjectText(subject));
	const senderNorm = normalizeChoiceText(cleanSenderName(sender));
	const dateNorm = normalizeChoiceText(date || "");

	for (const node of nodes) {
		const lines = String(node.innerText || "")
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean);
		if (!lines.length) continue;

		const startIdx = (() => {
			const dateIdx = dateNorm
				? lines.findIndex((l) => normalizeChoiceText(l) === dateNorm || normalizeChoiceText(l).includes(dateNorm))
				: -1;
			const subjIdx = subjectNorm
				? lines.findIndex((l) => normalizeChoiceText(cleanSubjectText(l)) === subjectNorm)
				: -1;
			return Math.max(dateIdx + 1, subjIdx + 1, 0);
		})();

		const bodyLines = lines.slice(startIdx).filter((l) => {
			const n = normalizeChoiceText(l);
			if (!n) return false;
			if (subjectNorm && n === subjectNorm) return false;
			if (senderNorm && n === senderNorm) return false;
			if (extractDateLike(l)) return false;
			if (/\bmark as unread\b|\bmark as read\b|\breply\b|\bforward\b/i.test(l)) return false;
			if (/^inbox$|^all courses$|^search$|^compose$|^settings$|^no conversations selected$/i.test(l)) return false;
			if (/section\s+\d+/i.test(l)) return false;
			return true;
		});
		slice(0, 40);

		const text = bodyLines.join(" ").replace(/\s+/g, " ").trim();
		if (text.length >= 20) return text;
	}
	return "";
}

async function readCurrentMessageDetailWithRetry(subjectHint = "") {
	let detail = readCurrentMessageDetail(subjectHint);
	if (detail?.bodyPreview) return detail;
	for (const ms of [700, 1000, 1300]) {
		await wait(ms);
		detail = readCurrentMessageDetail(subjectHint);
		if (detail?.bodyPreview) return detail;
	}
	return detail;
}

function readMessageIndexFromUtterance(text) {
	const u = String(text || "").toLowerCase();
	const wordMap = {
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

	for (const [w, idx] of Object.entries(wordMap)) {
		if (new RegExp(`\\b${w}\\b`).test(u)) return idx;
	}

	const m = u.match(/\b(\d{1,2})\b/);
	if (m) {
		const n = parseInt(m[1], 10);
		if (Number.isFinite(n) && n > 0) return n - 1;
	}

	const suffixed = u.match(/\b(\d{1,2})(st|nd|rd|th)\b/);
	if (suffixed) {
		const n = parseInt(suffixed[1], 10);
		if (Number.isFinite(n) && n > 0) return n - 1;
	}
	return null;
}

async function maybeHandleInboxAssist(utterance) {
	if (!isCanvasInboxPage()) return null;

	const u = String(utterance || "").trim();
	const lower = u.toLowerCase();
	const state = await mem.get();
	const inboxState = state.inboxAssist || {};

	if (isInboxReadCommand(lower)) {
		const unread = collectUnreadInboxRows();
		if (!unread.length) {
			await mem.set({ inboxAssist: null });
			await speak("You have no unread messages.", { mode: "say" });
			return { intent: "INBOX_READ", result: { ok: true, message: "No unread messages" } };
		}
		const countLine =
			unread.length === 1
				? "You have 1 new message. Say read first message."
				: `You have ${unread.length} new messages. Say read first message, read second message, or read message number.`;
		await mem.set({ inboxAssist: { awaitingConfirm: false, awaitingPick: true } });
		await speak(countLine, { mode: "say" });
		return { intent: "INBOX_READ", result: { ok: true, message: "Announced unread count and awaiting pick" } };
	}

	if (isReadLatestMessageCommand(lower)) {
		const all = collectInboxRows();
		if (!all.length) {
			await speak("I can't find messages right now.", { mode: "say" });
			return { intent: "INBOX_READ", result: { ok: false, message: "No inbox rows for latest message" } };
		}
		const target = all[0];
		target.row.click();
		await wait(700);
		const detail = await readCurrentMessageDetailWithRetry(target.subject);
		if (detail) {
			const senderRaw = detail.sender && detail.sender !== "Unknown sender" ? detail.sender : target.sender;
			const sender = cleanSenderName(senderRaw) || "Unknown sender";
			const subjectRaw = detail.subject && detail.subject !== "No subject" ? detail.subject : target.subject;
			const subject = cleanSubjectText(subjectRaw);
			const date = detail.date || target.date || "";
			const datePart = date ? ` from ${date}` : "";
			await speak(`Opening your latest message. Subject ${subject} from ${sender}${datePart}.`, { mode: "say" });
			if (detail.bodyPreview) {
				await speak(`Message: ${detail.bodyPreview}`, { raw: true, mode: "read" });
			}
		} else {
			const datePart = target.date ? ` from ${target.date}` : "";
			const targetSubject = cleanSubjectText(target.subject);
			const targetSender = cleanSenderName(target.sender) || "Unknown sender";
			await speak(`Opening your latest message. Subject ${targetSubject} from ${targetSender}${datePart}.`, {
				mode: "say",
			});
		}
		await mem.set({ inboxAssist: { awaitingConfirm: false, awaitingPick: true } });
		return { intent: "INBOX_READ", result: { ok: true, message: "Opened latest message" } };
	}

	if (inboxState.awaitingPick || isReadNthMessageCommand(lower)) {
		const unread = collectUnreadInboxRows();
		if (!unread.length) {
			await mem.set({ inboxAssist: null });
			await speak("I can't find unread messages right now.", { mode: "say" });
			return { intent: "INBOX_READ", result: { ok: false, message: "No unread to open" } };
		}

		const idx = readMessageIndexFromUtterance(lower);
		if (idx == null || idx < 0 || idx >= unread.length) {
			await speak(`Please say read first email up to read email ${Math.min(unread.length, 8)}.`, { mode: "say" });
			return { intent: "INBOX_READ", result: { ok: false, message: "Unread index invalid" } };
		}

		const target = unread[idx];
		target.row.click();
		await wait(700);
		const detail = await readCurrentMessageDetailWithRetry(target.subject);
		if (detail) {
			const senderRaw = detail.sender && detail.sender !== "Unknown sender" ? detail.sender : target.sender;
			const sender = cleanSenderName(senderRaw) || "Unknown sender";
			const subjectRaw = detail.subject && detail.subject !== "No subject" ? detail.subject : target.subject;
			const subject = cleanSubjectText(subjectRaw);
			const lead = `Opening message ${idx + 1}. From ${sender}. Subject ${subject}.`;
			await speak(lead, { mode: "say" });
			if (detail.bodyPreview) {
				await speak(`Message: ${detail.bodyPreview}`, { raw: true, mode: "read" });
			}
		} else {
			const targetSubject = cleanSubjectText(target.subject);
			const targetSender = cleanSenderName(target.sender) || "Unknown sender";
			await speak(`Opening message ${idx + 1}. From ${targetSender}. Subject ${targetSubject}.`, { mode: "say" });
		}
		await mem.set({ inboxAssist: { awaitingConfirm: false, awaitingPick: true } });
		return { intent: "INBOX_READ", result: { ok: true, message: "Opened unread by index" } };
	}

	return null;
}

function selectOptionsData(sel) {
	if (!sel) return [];
	return Array.from(sel.options)
		.map((o) => ({ value: o.value, label: (o.textContent || "").trim() }))
		.filter((o) => o.label && !/^select/i.test(o.label));
}

function optionIdxFromUtterance(utterance, options) {
	const raw = String(utterance || "")
		.toLowerCase()
		.trim();
	const hasChoiceCue = /\b(option|choice|number|pick)\b/.test(raw);
	const justNumeric = /^\d{1,2}$/.test(raw);
	const justOrdinal = /^(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)$/.test(raw);
	const shouldTreatAsIndex = hasChoiceCue || justNumeric || justOrdinal;

	if (!shouldTreatAsIndex) return null;

	const fromOrdinal = ordinalToIdx(raw);
	if (fromOrdinal != null && fromOrdinal >= 0 && fromOrdinal < options.length) return fromOrdinal;

	const num = raw.match(/\b(\d{1,2})\b/);
	if (num) {
		const i = parseInt(num[1], 10) - 1;
		if (i >= 0 && i < options.length) return i;
	}

	const u = normalizeChoiceText(utterance);
	if (!u) return null;

	let bestIdx = null;
	let bestScore = 0;
	options.forEach((opt, idx) => {
		const label = normalizeChoiceText(opt.label);
		let score = 0;
		if (label === u) score += 10;
		if (label.includes(u)) score += 8;
		if (u.includes(label) && label.length > 4) score += 4;
		const uTokens = u.split(" ").filter((x) => x.length > 2);
		uTokens.forEach((tok) => {
			if (label.includes(tok)) score += 1;
		});
		if (score > bestScore) {
			bestScore = score;
			bestIdx = idx;
		}
	});

	return bestScore >= 2 ? bestIdx : null;
}

async function speakNumberedOptions(prefix, options) {
	if (!options.length) return;
	const maxSpeak = Math.min(options.length, 12);
	const items = options
		.slice(0, maxSpeak)
		.map((o, i) => `option ${i + 1}, ${o.label}`)
		.join(". ");
	const suffix = options.length > maxSpeak ? " There are more options on screen." : "";
	await speak(`${prefix} ${items}.${suffix}`, { mode: "say" });
}

async function openComposeMessage() {
	if (!isCanvasInboxPage()) {
		await speak("Open Canvas Inbox first, then say compose message.", { mode: "say" });
		return { ok: false, message: "Not in inbox" };
	}

	if (isComposeDialogOpen()) {
		return { ok: true, message: "Compose already open" };
	}

	for (let attempt = 0; attempt < 6; attempt++) {
		const composeBtn =
			findVisibleButtonByText(/\bcompose\b/i) ||
			firstMatch([
				"button[data-testid*='compose' i]",
				"button[aria-label*='compose' i]",
				"[role='button'][aria-label*='compose' i]",
			]);
		if (composeBtn) {
			composeBtn.focus?.();
			composeBtn.click?.();
			composeBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
			composeBtn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
		}
		await wait(220);
		if (isComposeDialogOpen()) {
			return { ok: true, message: "Opened compose" };
		}
	}

	await speak("I couldn't open compose automatically. Please click Compose once, then say compose a message again.", {
		mode: "say",
	});
	return { ok: false, message: "Compose button click did not open dialog" };
}

async function ensureComposeOpen() {
	if (isComposeDialogOpen()) return true;
	const opened = await openComposeMessage();
	if (!opened?.ok) return false;
	for (let i = 0; i < 8; i++) {
		if (isComposeDialogOpen()) return true;
		await wait(120);
	}
	return false;
}

function recipientOptionsInListbox() {
	const listbox = Array.from(document.querySelectorAll("[role='listbox']")).find(isVisible);
	const root = listbox || getComposeRoot();
	const candidates = [
		...root.querySelectorAll("[role='option']"),
		...root.querySelectorAll("li"),
		...root.querySelectorAll("[data-testid*='option' i]"),
		...root.querySelectorAll("[id*='option' i]"),
	];
	return Array.from(new Set(candidates))
		.filter(isVisible)
		.map((el) => ({ el, label: (el.textContent || "").trim() }))
		.filter((o) => o.label.length > 0 && o.label.length < 160);
}

function isUtilityOptionLabel(label) {
	const t = String(label || "")
		.trim()
		.toLowerCase();
	return /^(back|go back|cancel|clear|close|search|type to search|no results)$/i.test(t);
}

function isCourseHeaderLabel(label) {
	const t = String(label || "")
		.trim()
		.toLowerCase();
	return /^(favorite courses|groups|all courses|courses)$/i.test(t);
}

function isLikelyDisabledRow(el) {
	if (!el) return false;
	if (el.getAttribute?.("aria-disabled") === "true") return true;
	if (el.matches?.("[role='presentation'], [role='separator'], [aria-hidden='true']")) return true;
	const cls = String(el.className || "").toLowerCase();
	return cls.includes("separator") || cls.includes("header") || cls.includes("group");
}

function visiblePopupItems() {
	const roots = [
		...Array.from(document.querySelectorAll("[role='listbox']")).filter(isVisible),
		...Array.from(document.querySelectorAll("[role='menu']")).filter(isVisible),
		...Array.from(document.querySelectorAll(".ui-select-menu, .ui-menu, .ui-popup-content")).filter(isVisible),
	];
	const pickRoots = roots.length ? roots : [getComposeRoot()];
	const out = [];
	for (const r of pickRoots) {
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
	const uniq = [];
	const seen = new Set();
	for (const row of out) {
		if (seen.has(row.el)) continue;
		seen.add(row.el);
		uniq.push(row);
	}
	return uniq;
}

function courseMenuOptions() {
	const filtered = visiblePopupItems().filter((o) => {
		if (isUtilityOptionLabel(o.label)) return false;
		if (isCourseHeaderLabel(o.label)) return false;
		if (isLikelyDisabledRow(o.el)) return false;
		const l = String(o.label || "").toLowerCase();
		return isCourseLikeText(l) || /\d{3,4}/.test(l) || /\bcapstone|network|ai\b/i.test(l);
	});

	const uniq = [];
	const seen = new Set();
	for (const o of filtered) {
		const label = cleanCourseLabelForSpeech(o.label);
		const key = normalizeCourseLabelText(label);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		uniq.push({ ...o, label });
	}
	return uniq;
}

function bestOptionByUtterance(options, utterance, { allowFallback = true, mode = "generic" } = {}) {
	if (!Array.isArray(options) || !options.length) return null;
	const idx = optionIdxFromUtterance(utterance, options);
	if (idx != null && idx >= 0 && idx < options.length) return options[idx];

	const ranked = rankedOptionsByUtterance(options, utterance, mode);
	const best = ranked[0] || null;
	const bestScore = best?.__score ?? Number.NEGATIVE_INFINITY;

	if (best && bestScore > 0) return best;
	if (!allowFallback) return null;

	// Never auto-pick "Back" rows as fallback.
	return options.find((o) => !isUtilityOptionLabel(o.label)) || options[0];
}

async function applyChosenCourseOption(chosen, wizard) {
	const { courseSelect } = getComposeElements();
	if (courseSelect && chosen.value) {
		courseSelect.value = chosen.value;
		courseSelect.dispatchEvent(new Event("change", { bubbles: true }));
	} else if (chosen.el) {
		chosen.el.click();
	}
	const chosenLabel = cleanCourseLabelForSpeech(chosen.label);
	wizard.selectedCourse = chosenLabel;
	await wait(250);

	const { recipientTypeSelect } = getComposeElements();
	const recipientTypeOptions = selectOptionsData(recipientTypeSelect);
	wizard.recipientTypeOptions = recipientTypeOptions;
	wizard.step = recipientTypeOptions.length ? "recipientType" : "recipient";
	wizard.courseDisambiguation = null;
	await mem.set({ composeWizard: wizard });

	if (wizard.step === "recipientType") {
		await speak(`Selected ${chosenLabel}. Do you want recipients from courses or users?`, { mode: "say" });
		await speakNumberedOptions("Recipient type options are.", recipientTypeOptions);
	} else {
		await speak(`Selected ${chosenLabel}. Who is the recipient?`, { mode: "say" });
	}
	return { ok: true, message: "Course selected" };
}

function fireKey(el, key) {
	el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
	el.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
}

async function hardSelectPopupOption(optionEl, recipientInput, typedText) {
	if (!optionEl) return false;
	optionEl.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
	optionEl.click?.();
	optionEl.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
	optionEl.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
	if (await confirmRecipientChosen(recipientInput, typedText)) return true;
	recipientInput.focus();
	fireKey(recipientInput, "Enter");
	return await confirmRecipientChosen(recipientInput, typedText);
}

async function confirmRecipientChosen(recipientEl, typedText) {
	await wait(120);
	const remainingOptions = recipientOptionsInListbox();
	// If popup closes, selection usually succeeded.
	if (!remainingOptions.length) return true;
	const currentValue = String(recipientEl?.value || recipientEl?.textContent || "")
		.trim()
		.toLowerCase();
	const wanted = String(typedText || "")
		.trim()
		.toLowerCase();
	if (wanted && currentValue !== wanted) return true;
	// If the popup is still open with many options, selection likely failed.
	return false;
}

async function trySendCompose() {
	const beforeDialog = getComposeDialog();
	const { sendButton } = getComposeElements();
	if (!sendButton) return { ok: false, message: "Send button missing" };

	sendButton.click();

	const start = Date.now();
	while (Date.now() - start < 2500) {
		const afterDialog = getComposeDialog();
		if (beforeDialog && !afterDialog) return { ok: true, message: "Compose dialog closed after send" };
		const banner = Array.from(document.querySelectorAll("[role='alert'], .ic-flash-success, .flashalert-message")).find(
			(el) => /sent|success/i.test((el.textContent || "").toLowerCase()),
		);
		if (banner) return { ok: true, message: "Success banner detected after send" };
		await wait(120);
	}

	return { ok: false, message: "Send could not be confirmed" };
}

async function chooseRecipientByName(name) {
	const { recipient } = getComposeElements();
	if (!recipient) return { ok: false, message: "Recipient field missing" };
	const text = String(name || "").trim();
	if (!text) return { ok: false, message: "Missing recipient name" };

	writeField(recipient, text);
	await wait(350);

	const options = dedupeOptionsByLabel(
		recipientOptionsInListbox().filter((o) => !isUtilityOptionLabel(o.label) && !isCourseHeaderLabel(o.label)),
	);
	if (options.length) {
		const ranked = rankedOptionsByUtterance(options, text, "generic");
		if (shouldDisambiguateRecipient(text, ranked)) {
			const candidates = ranked.slice(0, 3).map((x) => ({
				label: x.label,
				el: x.el || null,
			}));
			return { ok: false, message: "Recipient ambiguous", ambiguousCandidates: candidates };
		}

		const chosen = bestOptionByUtterance(options, text, { allowFallback: false });
		if (!chosen) {
			return { ok: false, message: "No matching recipient option" };
		}
		if (await hardSelectPopupOption(chosen.el, recipient, text)) {
			return { ok: true, chosen: chosen.label };
		}
	}

	recipient.focus();
	// First suggestion may be a utility row like "Back", so move twice.
	fireKey(recipient, "ArrowDown");
	await wait(80);
	fireKey(recipient, "ArrowDown");
	await wait(80);
	fireKey(recipient, "Enter");
	if (await confirmRecipientChosen(recipient, text)) {
		return { ok: true, chosen: text };
	}

	return { ok: false, message: "Could not confirm recipient selection" };
}

async function startComposeWizard() {
	const opened = await ensureComposeOpen();
	if (!opened) return { ok: false, message: "Compose unavailable" };

	let courseSelect = null;
	let recipientTypeSelect = null;
	let courseOptions = [];
	let recipientTypeOptions = [];

	for (let i = 0; i < 8; i++) {
		if (i < 5) {
			tryOpenCoursePicker();
			await wait(90);
		}
		const found = getComposeElements();
		courseSelect = found.courseSelect;
		recipientTypeSelect = found.recipientTypeSelect;
		courseOptions = selectOptionsData(courseSelect);
		if (!courseOptions.length) {
			courseOptions = courseMenuOptions().map((o) => ({ value: "", label: o.label, el: o.el }));
		}
		recipientTypeOptions = selectOptionsData(recipientTypeSelect);
		if (courseOptions.length || recipientTypeOptions.length || i === 7) break;
		await wait(250);
	}

	const wizard = {
		active: true,
		step: "course",
		courseOptions,
		recipientTypeOptions,
		courseDisambiguation: null,
		recipientDisambiguation: null,
		selectedCourse: "",
		recipientType: "",
		recipient: "",
		subject: "",
		body: "",
	};
	await mem.set({ composeWizard: wizard });

	if (wizard.step === "course") {
		await speak("Which course do you want to send the message to? Say list my options if you want me to read them.", {
			mode: "say",
		});
		return { ok: true, message: "Asked course selection" };
	}

	if (wizard.step === "recipientType") {
		await speak("Do you want recipients from courses or users?", { mode: "say" });
		await speakNumberedOptions("Recipient type options are.", recipientTypeOptions);
		return { ok: true, message: "Asked recipient type" };
	}

	await speak("Who is the recipient?", { mode: "say" });
	return { ok: true, message: "Asked recipient name" };
}

async function handleComposeWizardStep(utterance, wizard) {
	const u = String(utterance || "").trim();
	const lower = u.toLowerCase();

	if (!wizard?.active) return null;

	if (/\b(cancel|stop|discard|never mind|nevermind)\b/.test(lower)) {
		const { cancelButton } = getComposeElements();
		if (cancelButton) cancelButton.click();
		await clearComposeWizardState();
		await speak("Canceled compose message.", { mode: "say" });
		return { ok: true, message: "Compose canceled" };
	}

	if (wizard.step === "course") {
		tryOpenCoursePicker();
		await wait(120);
		const { courseSelect } = getComposeElements();
		let options = selectOptionsData(courseSelect);
		if (!options.length) {
			options = courseMenuOptions().map((o) => ({ value: "", label: o.label, el: o.el }));
		}
		if (wantsOptionList(u)) {
			if (options.length) {
				await speakNumberedOptions("Here are your course options.", options);
				return { ok: true, message: "Read course options on request" };
			}
			await speak(
				"I couldn't read the course options yet. Try opening the course dropdown once, then say list my options.",
				{
					mode: "say",
				},
			);
			return { ok: false, message: "Requested course options unavailable" };
		}
		if (!options.length) {
			if (/\bskip\b/.test(lower)) {
				wizard.step = wizard.recipientTypeOptions.length ? "recipientType" : "recipient";
				await mem.set({ composeWizard: wizard });
				if (wizard.step === "recipientType") {
					await speak("Okay, skipping course. Do you want recipients from courses or users?", { mode: "say" });
					await speakNumberedOptions("Recipient type options are.", wizard.recipientTypeOptions);
				} else {
					await speak("Okay, skipping course. Who is the recipient?", { mode: "say" });
				}
				return { ok: true, message: "Course skipped" };
			}
			// fallback: type course text into Canvas combobox and commit selection.
			const cb = getCourseCombobox();
			if (cb && u && !/\boption\s+\d+\b/i.test(lower)) {
				writeField(cb, u);
				await wait(100);
				fireKey(cb, "Enter");
				await wait(220);
				const selectedNow = String(cb.value || "").trim();
				if (selectedNow && normalizeChoiceText(selectedNow) !== normalizeChoiceText("select course")) {
					wizard.selectedCourse = selectedNow;
					const { recipientTypeSelect } = getComposeElements();
					const recipientTypeOptions = selectOptionsData(recipientTypeSelect);
					wizard.recipientTypeOptions = recipientTypeOptions;
					wizard.step = recipientTypeOptions.length ? "recipientType" : "recipient";
					await mem.set({ composeWizard: wizard });
					if (wizard.step === "recipientType") {
						await speak(`Selected ${selectedNow}. Do you want recipients from courses or users?`, { mode: "say" });
						await speakNumberedOptions("Recipient type options are.", recipientTypeOptions);
					} else {
						await speak(`Selected ${selectedNow}. Who is the recipient?`, { mode: "say" });
					}
					return { ok: true, message: "Course selected via combobox typing" };
				}
			}
			await speak(
				"I still can't read course options. Please open the course dropdown and say option number, or say skip course.",
				{ mode: "say" },
			);
			return { ok: false, message: "Course options unavailable" };
		}

		const chosen = bestOptionByUtterance(options, u, { allowFallback: false, mode: "course" });
		if (!chosen) {
			await speak("I couldn't match that course. Say the course name or option number.", { mode: "say" });
			await speakNumberedOptions("Course options are.", options);
			return { ok: false, message: "Course not matched" };
		}

		const ranked = rankedOptionsByUtterance(options, u, "course");
		if (shouldDisambiguateCourse(u, ranked)) {
			const top = ranked.slice(0, 5).map((x) => ({
				label: cleanCourseLabelForSpeech(x.label),
				value: x.value || "",
				el: x.el || null,
			}));
			const candidates = [];
			const seen = new Set();
			for (const c of top) {
				const key = normalizeCourseLabelText(c.label);
				if (!key || seen.has(key)) continue;
				seen.add(key);
				candidates.push(c);
				if (candidates.length >= 3) break;
			}
			wizard.step = "course_disambiguate";
			wizard.courseDisambiguation = candidates;
			await mem.set({ composeWizard: wizard });
			await speak("I found similar course names. Which one did you mean?", { mode: "say" });
			await speakNumberedOptions("Your options are.", candidates);
			return { ok: true, message: "Asked user to disambiguate course" };
		}

		return await applyChosenCourseOption(chosen, wizard);
	}

	if (wizard.step === "course_disambiguate") {
		const candidates = Array.isArray(wizard.courseDisambiguation) ? wizard.courseDisambiguation : [];
		if (!candidates.length) {
			wizard.step = "course";
			await mem.set({ composeWizard: wizard });
			await speak("Let's try course selection again. Which course do you want?", { mode: "say" });
			return { ok: false, message: "No disambiguation candidates available" };
		}

		const chosen = bestOptionByUtterance(candidates, u, { allowFallback: false, mode: "course" });
		if (!chosen) {
			await speak("Please say the course name or option number.", { mode: "say" });
			await speakNumberedOptions("Your options are.", candidates);
			return { ok: false, message: "Disambiguation course not matched" };
		}

		return await applyChosenCourseOption(chosen, wizard);
	}

	if (wizard.step === "recipientType") {
		const { recipientTypeSelect } = getComposeElements();
		const options = selectOptionsData(recipientTypeSelect);
		if (!recipientTypeSelect || !options.length) {
			wizard.step = "recipient";
			await mem.set({ composeWizard: wizard });
			await speak("I can't find recipient type options. Who is the recipient?", { mode: "say" });
			return { ok: true, message: "Skipped recipient type" };
		}

		let idx = optionIdxFromUtterance(u, options);
		if (idx == null) {
			if (/\busers?\b/.test(lower)) idx = options.findIndex((o) => /users?/i.test(o.label));
			if (idx == null || idx < 0) {
				if (/\bcourses?\b/.test(lower)) idx = options.findIndex((o) => /courses?/i.test(o.label));
			}
		}
		if (idx == null || idx < 0) {
			await speak("Please say users or courses, or say an option number.", { mode: "say" });
			return { ok: false, message: "Recipient type not matched" };
		}

		const chosen = options[idx];
		recipientTypeSelect.value = chosen.value;
		recipientTypeSelect.dispatchEvent(new Event("change", { bubbles: true }));
		wizard.recipientType = chosen.label;
		wizard.step = "recipient";
		await mem.set({ composeWizard: wizard });
		await speak(`Selected ${chosen.label}. Who is the recipient?`, { mode: "say" });
		return { ok: true, message: "Recipient type selected" };
	}

	if (wizard.step === "recipient") {
		const name = cleanUtterancePayload(u, [/^(recipient|to)\s+/i, /^send\s+to\s+/i]);
		const picked = await chooseRecipientByName(name);
		if (!picked.ok) {
			if (Array.isArray(picked.ambiguousCandidates) && picked.ambiguousCandidates.length) {
				wizard.step = "recipient_disambiguate";
				wizard.recipientDisambiguation = picked.ambiguousCandidates;
				await mem.set({ composeWizard: wizard });
				await speak("I found multiple similar recipients. Which one do you mean?", { mode: "say" });
				await speakNumberedOptions("Your options are.", picked.ambiguousCandidates);
				return { ok: true, message: "Asked user to disambiguate recipient" };
			}
			await speak("I couldn't select that recipient. Please say the name again.", { mode: "say" });
			return { ok: false, message: "Recipient not selected" };
		}
		wizard.recipient = picked.chosen || name;
		wizard.step = "subject";
		await mem.set({ composeWizard: wizard });
		await speak("What is the subject line?", { mode: "say" });
		return { ok: true, message: "Recipient selected" };
	}

	if (wizard.step === "recipient_disambiguate") {
		const candidates = Array.isArray(wizard.recipientDisambiguation) ? wizard.recipientDisambiguation : [];
		if (!candidates.length) {
			wizard.step = "recipient";
			await mem.set({ composeWizard: wizard });
			await speak("Let's try the recipient again. Who is the recipient?", { mode: "say" });
			return { ok: false, message: "No recipient disambiguation candidates" };
		}
		const chosen = bestOptionByUtterance(candidates, u, { allowFallback: false, mode: "generic" });
		if (!chosen) {
			await speak("Please say the recipient name or option number.", { mode: "say" });
			await speakNumberedOptions("Your options are.", candidates);
			return { ok: false, message: "Recipient disambiguation not matched" };
		}
		const picked = await chooseRecipientByName(chosen.label);
		if (!picked.ok) {
			await speak("I still couldn't select that recipient. Please try again.", { mode: "say" });
			return { ok: false, message: "Recipient disambiguation selection failed" };
		}
		wizard.recipient = picked.chosen || chosen.label;
		wizard.step = "subject";
		wizard.recipientDisambiguation = null;
		await mem.set({ composeWizard: wizard });
		await speak("Got it. What is the subject line?", { mode: "say" });
		return { ok: true, message: "Recipient disambiguation selected" };
	}

	if (wizard.step === "subject") {
		const { subject } = getComposeElements();
		if (!subject) {
			await speak("I couldn't find the subject field.", { mode: "say" });
			return { ok: false, message: "Subject field missing" };
		}
		const text = cleanUtterancePayload(u, [/^(subject|subject is|subject line|subject to)\s*/i]);
		if (!text) {
			await speak("Please say the subject line.", { mode: "say" });
			return { ok: false, message: "Empty subject" };
		}
		writeField(subject, text);
		wizard.subject = text;
		wizard.step = "body";
		await mem.set({ composeWizard: wizard });
		await speak("What is the message?", { mode: "say" });
		return { ok: true, message: "Subject set" };
	}

	if (wizard.step === "body") {
		const { body } = getComposeElements();
		if (!body) {
			await speak("I couldn't find the message box.", { mode: "say" });
			return { ok: false, message: "Body field missing" };
		}
		const text = cleanUtterancePayload(u, [/^(message|message is|body|body is|dictate)\s*/i]);
		if (!text) {
			await speak("Please say the message text.", { mode: "say" });
			return { ok: false, message: "Empty body" };
		}
		writeField(body, text);
		wizard.body = text;
		wizard.step = "confirm";
		await mem.set({ composeWizard: wizard });
		await speak("Do you want to send, cancel, or reread the message?", { mode: "say" });
		return { ok: true, message: "Body set" };
	}

	if (wizard.step === "confirm") {
		if (/\breread|read back|read it back|repeat\b/.test(lower)) {
			const parts = [];
			if (wizard.selectedCourse) parts.push(`Course: ${wizard.selectedCourse}`);
			if (wizard.recipientType) parts.push(`Recipient type: ${wizard.recipientType}`);
			if (wizard.recipient) parts.push(`Recipient: ${wizard.recipient}`);
			if (wizard.subject) parts.push(`Subject: ${wizard.subject}`);
			if (wizard.body) parts.push(`Message: ${wizard.body}`);
			await speak(parts.join(". "), { mode: "say" });
			await speak("Say send, cancel, or say subject or message to change them.", { mode: "say" });
			return { ok: true, message: "Reread compose message" };
		}

		if (/\bsend\b/.test(lower)) {
			const sent = await trySendCompose();
			if (!sent.ok) {
				await speak(
					"I clicked send, but I could not confirm the message was sent. Please check the form and try send again.",
					{ mode: "say" },
				);
				return { ok: false, message: sent.message };
			}
			await clearComposeWizardState();
			await speak("Message sent.", { mode: "say" });
			return { ok: true, message: "Message sent" };
		}

		if (/^subject\b/.test(lower)) {
			wizard.step = "subject";
			await mem.set({ composeWizard: wizard });
			await speak("Okay, what is the new subject line?", { mode: "say" });
			return { ok: true, message: "Editing subject" };
		}

		if (/^(message|body)\b/.test(lower)) {
			wizard.step = "body";
			await mem.set({ composeWizard: wizard });
			await speak("Okay, what is the new message?", { mode: "say" });
			return { ok: true, message: "Editing body" };
		}

		await speak("Please say send, cancel, or reread.", { mode: "say" });
		return { ok: false, message: "Awaiting confirmation command" };
	}
	return { ok: false, message: `Unknown wizard step: ${wizard.step}` };
}

async function handleDiscussionWizardStep(utterance, wizard) {
	const u = String(utterance || "").trim();
	const lower = u.toLowerCase();
	if (!wizard?.active) return null;

	if (/\b(cancel|stop|discard|never mind|nevermind)\b/.test(lower)) {
		await clearDiscussionWizardState();
		await speak("Canceled add discussion.", { mode: "say" });
		return { ok: true, message: "Discussion wizard canceled" };
	}

	if (!isDiscussionNewPage()) {
		const opened = await openDiscussionComposer();
		if (!opened) {
			await speak("I am still opening the discussion form. Please say your answer again in a moment.", { mode: "say" });
			return { ok: false, message: "Discussion form not ready" };
		}
	}

	if (wizard.step === "title") {
		const titleText = cleanUtterancePayload(u, [/^(title|topic title|topic)\s*(is|:)?\s*/i]);
		if (!titleText) {
			await speak("I did not catch the topic title. Please say it again.", { mode: "say" });
			return { ok: false, message: "Missing topic title" };
		}
		const input = getDiscussionTitleInput();
		if (!input || !writeField(input, titleText)) {
			await speak("I could not fill the topic title field. Please click the title box and try again.", { mode: "say" });
			return { ok: false, message: "Topic title field missing" };
		}
		wizard.title = titleText;
		wizard.step = "content";
		wizard.lastPromptKey = "";
		wizard.autoPromptBlockedUntil = Date.now() + 5000;
		await mem.set({ discussionWizard: wizard });
		await speak("Topic title recorded.", { mode: "say" });
		await promptDiscussionStep(wizard, { force: true });
		return { ok: true, message: "Topic title recorded" };
	}

	if (wizard.step === "content") {
		const contentText = cleanUtterancePayload(u, [/^(content|topic content|body|message)\s*(is|:)?\s*/i]);
		if (!contentText) {
			await speak("I did not catch the topic content. Please say it again.", { mode: "say" });
			return { ok: false, message: "Missing topic content" };
		}
		const ok = writeDiscussionContent(contentText);
		if (!ok) {
			await speak("I could not fill the topic content editor. Please click in the editor and try again.", {
				mode: "say",
			});
			return { ok: false, message: "Topic content editor missing" };
		}
		wizard.content = contentText;
		wizard.step = "require_before_reply";
		wizard.lastPromptKey = "";
		wizard.autoPromptBlockedUntil = Date.now() + 5000;
		await mem.set({ discussionWizard: wizard });
		await speak(`Topic content recorded: ${contentText}`, { mode: "say" });
		await promptDiscussionStep(wizard, { force: true });
		return { ok: true, message: "Topic content recorded" };
	}

	if (wizard.step === "require_before_reply") {
		const yn = parseYesNo(u);
		if (yn == null) {
			await speak("Please say yes or no for the participants must respond option.", { mode: "say" });
			return { ok: false, message: "Expected yes/no for participants option" };
		}
		const cb =
			getDiscussionRequireInitialPostCheckbox() ||
			findLabelCheckbox(/participants must respond to the topic before viewing other replies/i) ||
			findLabelCheckbox(/respond.*before.*repl/i) ||
			findLabelCheckbox(/viewing other replies/i);
		if (!cb || !setCheckboxValue(cb, yn)) {
			await speak("I could not toggle that option automatically. Please set it manually, then continue.", {
				mode: "say",
			});
			return { ok: false, message: "Participants option checkbox not found" };
		}
		wizard.respondBeforeReplies = yn;
		wizard.step = "allow_liking";
		wizard.lastPromptKey = "";
		wizard.autoPromptBlockedUntil = Date.now() + 5000;
		await mem.set({ discussionWizard: wizard });
		await speak(`Participants must respond option set to ${yn ? "yes" : "no"}.`, { mode: "say" });
		await promptDiscussionStep(wizard, { force: true });
		return { ok: true, message: "Participants option set" };
	}

	if (wizard.step === "allow_liking") {
		const yn = parseYesNo(u);
		if (yn == null) {
			await speak("Please say yes or no for allow liking.", { mode: "say" });
			return { ok: false, message: "Expected yes/no for allow liking" };
		}
		const cb =
			getDiscussionAllowLikingCheckbox() || findLabelCheckbox(/allow liking/i) || findLabelCheckbox(/\bliking\b/i);
		if (!cb || !setCheckboxValue(cb, yn)) {
			await speak("I could not toggle allow liking automatically. Please set it manually, then continue.", {
				mode: "say",
			});
			return { ok: false, message: "Allow liking checkbox not found" };
		}
		wizard.allowLiking = yn;
		wizard.step = "confirm_submit";
		wizard.lastPromptKey = "";
		wizard.autoPromptBlockedUntil = Date.now() + 5000;
		await mem.set({ discussionWizard: wizard });
		await speak(`Allow liking set to ${yn ? "yes" : "no"}.`, { mode: "say" });
		await promptDiscussionStep(wizard, { force: true });
		return { ok: true, message: "Allow liking option set" };
	}

	if (wizard.step === "confirm_submit") {
		const yn = parseYesNo(u);
		if (yn == null) {
			await speak("Please say yes to submit or no to keep editing.", { mode: "say" });
			return { ok: false, message: "Expected yes/no for submit confirmation" };
		}
		if (!yn) {
			await clearDiscussionWizardState();
			await speak("Okay, I did not submit. Your discussion is ready for manual edits.", { mode: "say" });
			return { ok: true, message: "Submit canceled by user" };
		}
		const submitBtn = findDiscussionSubmitButton();
		if (!submitBtn) {
			await speak("I could not find the submit button. Please review the form and submit manually.", { mode: "say" });
			return { ok: false, message: "Discussion submit button not found" };
		}
		submitBtn.focus?.();
		submitBtn.click?.();
		await clearDiscussionWizardState();
		await speak("Submitted.", { mode: "say" });
		return { ok: true, message: "Discussion submitted" };
	}

	await clearDiscussionWizardState();
	return { ok: false, message: `Unknown discussion wizard step: ${wizard.step}` };
}

async function maybeHandleDiscussionWizard(utterance) {
	const state = await mem.get();
	const wizard = state?.discussionWizard;
	const u = String(utterance || "").trim();
	const isTrigger = looksLikeDiscussionTrigger(u);

	if (isTrigger) {
		await clearDiscussionWizardState();
		const result = await startDiscussionWizard();
		return {
			intent: intents.ADD_DISCUSSION,
			result: { ...result, confidence: 0.98, reason: "discussion wizard start" },
		};
	}

	if (wizard?.active) {
		const result = await handleDiscussionWizardStep(utterance, wizard);
		return {
			intent: "DISCUSSION_WIZARD_STEP",
			result: { ...result, confidence: 0.99, reason: "discussion wizard active" },
		};
	}

	return null;
}

async function maybeHandleHandsFreeInbox(utterance) {
	const state = await mem.get();
	const wizard = state.composeWizard;
	const u = String(utterance || "").trim();
	const isComposeTrigger = looksLikeComposeTrigger(u);

	// Saying "compose a message" should always restart a fresh wizard.
	if (isComposeTrigger) {
		await clearComposeWizardState();
		const result = await startComposeWizard();
		return {
			intent: intents.COMPOSE_MESSAGE,
			result: { ...result, confidence: 0.98, reason: "compose wizard start" },
		};
	}

	if (wizard?.active) {
		const result = await handleComposeWizardStep(utterance, wizard);
		return {
			intent: "COMPOSE_WIZARD_STEP",
			result: { ...result, confidence: 0.99, reason: "compose wizard active" },
		};
	}

	return null;
}

async function actComposeMessage(slots = {}) {
	const utterance = slots.utterance || "compose message";
	const handled = await maybeHandleHandsFreeInbox(utterance);
	return handled?.result || { ok: false, message: "Compose wizard not started" };
}

async function actAddDiscussion(slots = {}) {
	const utterance = slots.utterance || "add discussion";
	const handled = await maybeHandleDiscussionWizard(utterance);
	return handled?.result || { ok: false, message: "Discussion wizard not started" };
}
