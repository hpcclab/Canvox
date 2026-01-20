// lib/actions.js
// PERSON B — Action router for detected intents.
// Depends on intent enums + Memory from lib/intent.js

import { intents, Memory, normalize } from "./intent.js";

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
      steps,      // [{ intent, slots }]
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
	// Only handles "open ..." style course asks. Returns null if not course-ish.
	const s = String(cleaned || "").toLowerCase().trim();

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
			await askChoice(filtered.slice(0, 8).map((o) => ({ label: o.label, href: o.href })), prompt);
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
		await askChoice(similar.map((o) => ({ label: o.label, href: o.href })), prompt);
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
		{ kind: "DUE_IN_COURSE", courseNum, md, dueText }
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
	const u = normalize(utterance);

	if (/\b(thanks|thank you|appreciate)\b/.test(u)) {
		await speak("You got it.", { mode: "say" });
		return { ok: true, message: "Small talk: thanks" };
	}
	if (/\b(how are you|hows it going|how s it going|whats up|what s up)\b/.test(u)) {
		await speak("I’m ready. What do you want to do on Canvas?", { mode: "say" });
		return { ok: true, message: "Small talk: how are you" };
	}
	if (/\b(hello|hi|hey)\b/.test(u)) {
		await speak("Hey. Try: open courses, open assignments, open grades, or open homework 2.", { mode: "say" });
		return { ok: true, message: "Small talk: hello" };
	}
	if (/\b(nice|cool|great|awesome|sweet|good job)\b/.test(u)) {
		await speak("Nice. What next?", { mode: "say" });
		return { ok: true, message: "Small talk: positive" };
	}

	await speak("Okay. What next?", { mode: "say" });
	return { ok: true, message: "Small talk: default" };
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
		"Try: open dashboard. Go back. Open grades. Open assignments. Open courses. Open course 1040. Open homework 2. Read the page. Next section. Repeat.";
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

		// --- string fallbacks (so you don't need to touch intent.js for compound commands) ---
		case "OPEN_ASSIGNMENTS_FOR_COURSE":
			return await actOpenAssignmentsForCourse(slots.courseNum);
		case INTERNAL_INTENTS.OPEN_ASSIGNMENT_DUE_IN:
			return await actOpenAssignmentDueIn(slots.md);

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
    window.__convoxResumeTimer = setTimeout(() => resumePlanIfAny(), 250);
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

	// ✅ If expecting choice, handle choice — but allow overrides + repeat
	const ctx0 = await mem.get();
	if (ctx0?.expectingChoice) {
		const u = String(cleaned || "").toLowerCase().trim();

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
			/\b(dashboard|home|courses|assignments|grades|go back|back|help|read page|next section|repeat)\b/.test(u);

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

	// ✅ NEW: intercept course-ish "open ..." BEFORE NLU (your existing logic)
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
	const { intent, slots, confidence, reason } = await detector(cleaned, context);

	if (intent === intents.SMALL_TALK) {
		slots.utterance = cleaned;
	}

	if (confidence < 0.45 && intent !== intents.HELP && intent !== intents.SMALL_TALK) {
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
