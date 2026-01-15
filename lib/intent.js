// lib/intent.js
// PERSON B — Natural Language & Intent Brain (NLU core)
// ES module. No external deps required. Optional TF.js scoring hook included (disabled by default).

/**
 * Public API:
 *  - normalize(text)
 *  - detectIntent(utterance, context?) -> { intent, slots, confidence, reason }
 *  - intents (enum)
 *  - Memory (class) – wrapper over chrome.storage.local/localStorage
 */

export const intents = {
	OPEN_GRADES: "OPEN_GRADES",
	OPEN_ASSIGNMENTS: "OPEN_ASSIGNMENTS",
	OPEN_TASKS: "OPEN_TASKS",
	OPEN_COURSES: "OPEN_COURSES",

	OPEN_COURSE_BY_NUMBER: "OPEN_COURSE_BY_NUMBER", // "open course 1040"
	CHOOSE_OPTION: "CHOOSE_OPTION", // "option 2" / "second"

	NAVIGATE_TO: "NAVIGATE_TO", // generic "open X" if we can resolve X to a link
	READ_PAGE: "READ_PAGE",
	READ_NEXT: "READ_NEXT",
	REPEAT: "REPEAT",
	HELP: "HELP",
	AFFIRM: "AFFIRM",
	DENY: "DENY",
	UNKNOWN: "UNKNOWN",
};

// --- Utilities ---------------------------------------------------------------

export function normalize(text = "") {
	return text
		.toLowerCase()
		.replace(/[“”"']/g, "")
		.replace(/[-_]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

const SYN = {
	grades: ["grades", "marks", "scores", "gradebook", "result", "results"],
	assignments: ["assignments", "assignment", "tasks", "homework", "hw", "work", "submissions", "to do", "to-do"],
	courses: ["courses", "course", "classes", "class", "subjects", "class list", "course list", "dashboard"],

	open: ["open", "go to", "navigate to", "take me to", "show me", "bring me to"],
	read: ["read", "speak", "say", "narrate"],
	next: ["next", "continue", "go on", "proceed", "keep reading"],
	repeat: ["repeat", "again", "say again", "one more time"],
	yes: ["yes", "yeah", "yep", "sure", "ok", "okay", "do it"],
	no: ["no", "nope", "nah", "don’t", "dont", "do not", "stop"],

	// choice words
	optionWord: ["option", "number", "choice"],
	ordinals: ["first", "second", "third", "fourth", "fifth"],
};

function escapeReg(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function anySyn(key) {
	return (SYN[key] || []).map(escapeReg).join("|");
}

// --- Regexes -----------------------------------------------------------------

const RE = {
	// e.g., "open my grades", "take me to marks", "go to assignments"
	openGrades: new RegExp(`\\b(${anySyn("open")})\\s+(my\\s+)?(${anySyn("grades")})\\b`),
	openAssignments: new RegExp(`\\b(${anySyn("open")})\\s+(my\\s+)?(${anySyn("assignments")})\\b`),
	openCourses: new RegExp(`\\b(${anySyn("open")})\\s+(my\\s+)?(${anySyn("courses")})\\b`),

	// course number intent: "open course 1040", "open 1040", "go to csce 1040"
	// NOTE: we keep it permissive: if utterance contains an open verb + a 3-5 digit number, we treat as course number
	openCourseByNumber: new RegExp(`\\b(${anySyn("open")})\\b.*\\b(?<num>\\d{3,5})\\b`),

	// choice: "option 2", "number 1", "second", "3"
	chooseOption: new RegExp(`\\b(?:(${anySyn("optionWord")})\\s*)?(?<idx>\\d+|${anySyn("ordinals")})\\b`),

	// generic: "open <something>"
	openGeneric: new RegExp(`\\b(${anySyn("open")})\\s+(?<target>.+)$`),

	// reading
	readPage: new RegExp(`\\b(${anySyn("read")})\\b.*\\b(page|this|content|everything)\\b|\\b(read the page)\\b`),
	readNext: new RegExp(
		`\\b(${anySyn("read")})\\b.*\\b(${anySyn("next")})\\b|\\b(${anySyn("next")})\\s+(part|section|one)\\b`,
	),
	repeat: new RegExp(`\\b(${anySyn("repeat")})\\b`),

	help: /\b(help|what can you do|how to|commands)\b/,

	affirm: new RegExp(`\\b(${anySyn("yes")})\\b`),
	deny: new RegExp(`\\b(${anySyn("no")})\\b`),

	// bare keywords (fallback boosts)
	kwGrades: new RegExp(`\\b(${anySyn("grades")})\\b`),
	kwAssignments: new RegExp(`\\b(${anySyn("assignments")})\\b`),
	kwCourses: new RegExp(`\\b(${anySyn("courses")})\\b`),
	kwReadNext: new RegExp(`\\b(${anySyn("next")})\\b`),
	kwOpenVerb: new RegExp(`\\b(${anySyn("open")})\\b`),
};

// --- Minimal scorer ----------------------------------------------------------
// Optional TF.js rescoring hook (disabled by default to avoid extra weight/size).
const TF_ENABLED = false;

async function tfScore(/* utterance, guess */) {
	return 1.0;
}

// --- Memory ------------------------------------------------------------------

export class Memory {
	constructor(namespace = "convox_nlu") {
		this.ns = namespace;
		this.inChrome = typeof chrome !== "undefined" && chrome?.storage?.local;
	}

	async get() {
		if (this.inChrome) {
			const data = await new Promise((res) => chrome.storage.local.get(this.ns, (v) => res(v)));
			return data?.[this.ns] || {};
		}
		try {
			return JSON.parse(localStorage.getItem(this.ns) || "{}");
		} catch {
			return {};
		}
	}

	async set(patch) {
		const current = await this.get();
		const next = { ...current, ...patch, updatedAt: Date.now() };
		if (this.inChrome) {
			await new Promise((res) => chrome.storage.local.set({ [this.ns]: next }, res));
		} else {
			localStorage.setItem(this.ns, JSON.stringify(next));
		}
		return next;
	}

	async clear() {
		if (this.inChrome) {
			await new Promise((res) => chrome.storage.local.remove(this.ns, res));
		} else {
			localStorage.removeItem(this.ns);
		}
	}
}

// --- Intent detection --------------------------------------------------------

function scored(intent, confidence, slots = {}, reason = "") {
	return { intent, confidence, slots, reason };
}

function parseCourseNum(u) {
	// choose first 3-5 digit token that looks like a course number
	const m = u.match(/\b(\d{3,5})\b/);
	return m ? m[1] : null;
}

function normalizeChoiceIdx(idxRaw) {
	const t = String(idxRaw || "")
		.toLowerCase()
		.trim();
	const map = { first: "1", second: "2", third: "3", fourth: "4", fifth: "5" };
	if (map[t]) return map[t];
	const n = parseInt(t, 10);
	return Number.isFinite(n) ? String(n) : null;
}

/**
 * detectIntent
 * @param {string} rawUtterance
 * @param {object} context  optional prior state (lastIntent, lastLinkText, lastSectionId, expectingYesNo, expectingChoice)
 */
export async function detectIntent(rawUtterance = "", context = {}) {
	const u = normalize(rawUtterance);
	if (!u) return scored(intents.UNKNOWN, 0.0, {}, "empty");

	// ✅ Choice mode: only trigger CHOOSE_OPTION if user actually gave a choice
	if (context?.expectingChoice) {
		const m = u.match(RE.chooseOption);
		if (m?.groups?.idx) {
			const idx = normalizeChoiceIdx(m.groups.idx);
			if (idx) return scored(intents.CHOOSE_OPTION, 0.92, { idx }, "context: chooseOption");
		}
		// If they didn't say a choice, DO NOT force CHOOSE_OPTION. Continue.
	}

	// Strong rule matches (high confidence)
	if (RE.openGrades.test(u)) return scored(intents.OPEN_GRADES, 0.98, {}, "rule: openGrades");
	if (RE.openAssignments.test(u)) return scored(intents.OPEN_ASSIGNMENTS, 0.97, {}, "rule: openAssignments");
	if (RE.openCourses.test(u)) return scored(intents.OPEN_COURSES, 0.96, {}, "rule: openCourses");
	if (RE.readPage.test(u)) return scored(intents.READ_PAGE, 0.95, {}, "rule: readPage");
	if (RE.readNext.test(u)) return scored(intents.READ_NEXT, 0.93, {}, "rule: readNext");
	if (RE.repeat.test(u)) return scored(intents.REPEAT, 0.9, {}, "rule: repeat");
	if (RE.help.test(u)) return scored(intents.HELP, 0.9, {}, "rule: help");

	// Yes/No handling when a question was asked
	if (context?.expectingYesNo) {
		if (RE.affirm.test(u)) return scored(intents.AFFIRM, 0.9, {}, "context: affirm");
		if (RE.deny.test(u)) return scored(intents.DENY, 0.9, {}, "context: deny");
	} else {
		if (RE.affirm.test(u)) return scored(intents.AFFIRM, 0.6, {}, "ambient affirm");
		if (RE.deny.test(u)) return scored(intents.DENY, 0.6, {}, "ambient deny");
	}

	// Course-by-number rule (must have open verb AND 3-5 digits)
	if (RE.openCourseByNumber.test(u)) {
		const courseNum = parseCourseNum(u);
		if (courseNum) return scored(intents.OPEN_COURSE_BY_NUMBER, 0.92, { courseNum }, "rule: openCourseByNumber");
	}

	// Generic "open <target>"
	const og = u.match(RE.openGeneric);
	if (og?.groups?.target) {
		const target = og.groups.target.trim();
		const onlyNum = normalize(target).match(/^\d{3,5}$/);
		if (onlyNum) {
			return scored(intents.OPEN_COURSE_BY_NUMBER, 0.9, { courseNum: onlyNum[0] }, "rule: openGeneric->courseNum");
		}
		return scored(intents.NAVIGATE_TO, 0.8, { target }, "rule: openGeneric");
	}

	// Keyword fallback boosts
	if (RE.kwGrades.test(u)) return scored(intents.OPEN_GRADES, 0.7, {}, "kw: grades");
	if (RE.kwAssignments.test(u)) return scored(intents.OPEN_ASSIGNMENTS, 0.7, {}, "kw: assignments");
	if (RE.kwCourses.test(u)) return scored(intents.OPEN_COURSES, 0.65, {}, "kw: courses");
	if (RE.kwReadNext.test(u)) return scored(intents.READ_NEXT, 0.6, {}, "kw: next");

	// Optional TF.js rescoring hook (disabled by default)
	let guess = scored(intents.UNKNOWN, 0.25, {}, "default");
	if (TF_ENABLED) {
		try {
			const multiplier = await tfScore(u, guess);
			guess = {
				...guess,
				confidence: Math.max(Math.min(guess.confidence * multiplier, 0.99), 0.01),
				reason: guess.reason + " +tf",
			};
		} catch {}
	}
	return guess;
}
