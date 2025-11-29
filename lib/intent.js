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
	assignments: ["assignments", "tasks", "homework", "hw", "work", "submissions"],
	courses: ["courses", "classes", "subjects", "class list", "course list", "dashboard"],
	open: ["open", "go to", "navigate to", "take me to", "show me", "bring me to"],
	read: ["read", "speak", "say", "narrate"],
	next: ["next", "continue", "go on", "proceed", "keep reading"],
	repeat: ["repeat", "again", "say again", "one more time"],
	yes: ["yes", "yeah", "yep", "sure", "ok", "okay", "do it"],
	no: ["no", "nope", "nah", "don’t", "dont", "do not", "stop"],
};

function anySyn(key) {
	return SYN[key].map(escapeReg).join("|");
}
function escapeReg(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const RE = {
	// e.g., "open my grades", "take me to marks", "go to assignments"
	openGrades: new RegExp(`\\b(${anySyn("open")})\\s+(my\\s+)?(${anySyn("grades")})\\b`),
	openAssignments: new RegExp(`\\b(${anySyn("open")})\\s+(my\\s+)?(${anySyn("assignments")})\\b`),
	openCourses: new RegExp(`\\b(${anySyn("open")})\\s+(my\\s+)?(${anySyn("courses")})\\b`),

	// generic: "open <something>"
	openGeneric: new RegExp(`\\b(${anySyn("open")})\\s+(?<target>.+)$`),

	// reading / navigation memory
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
};

// --- Minimal scorer ----------------------------------------------------------
// The rules above assign a confidence. Optionally you can plug in TF.js to re-score.
// Keep disabled by default to avoid extra weight/size for the extension.
const TF_ENABLED = false;

async function tfScore(/* utterance, guess */) {
	// placeholder: return neutral multiplier
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

/**
 * detectIntent
 * @param {string} utterance
 * @param {object} context  optional prior state (lastIntent, lastLinkText, lastSectionId, expectingYesNo)
 */
export async function detectIntent(rawUtterance = "", context = {}) {
	const u = normalize(rawUtterance);

	if (!u) return scored(intents.UNKNOWN, 0.0, {}, "empty");

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
		// General yes/no with lower confidence
		if (RE.affirm.test(u)) return scored(intents.AFFIRM, 0.6, {}, "ambient affirm");
		if (RE.deny.test(u)) return scored(intents.DENY, 0.6, {}, "ambient deny");
	}

	// Generic "open <target>"
	const og = u.match(RE.openGeneric);
	if (og?.groups?.target) {
		const target = og.groups.target.trim();
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
		} catch {
			// ignore TF failures
		}
	}

	return guess;
}
