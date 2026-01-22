// lib/intent.js
// PERSON B — Natural Language & Intent Brain (NLU core)
import { llmClassifyIntent } from "./tiny_llm.js";

export const intents = {
	OPEN_GRADES: "OPEN_GRADES",
	OPEN_ASSIGNMENTS: "OPEN_ASSIGNMENTS",
	OPEN_TASKS: "OPEN_TASKS",
	OPEN_COURSES: "OPEN_COURSES",
	SUBMIT_ASSIGNMENT: "SUBMIT_ASSIGNMENT",


	OPEN_COURSE_BY_NUMBER: "OPEN_COURSE_BY_NUMBER",
	OPEN_COURSE_SECTION: "OPEN_COURSE_SECTION", // e.g., "open assignments of csce 3530"
	OPEN_ASSIGNMENT_QUERY: "OPEN_ASSIGNMENT_QUERY", // e.g., "open hw 2"
	CHOOSE_OPTION: "CHOOSE_OPTION",

	// ✅ Compound / multi-step intents (for plan runner in actions.js)
	OPEN_ASSIGNMENTS_FOR_COURSE: "OPEN_ASSIGNMENTS_FOR_COURSE", // "open assignments for course csce 4901"
	OPEN_ASSIGNMENT_FOR_COURSE: "OPEN_ASSIGNMENT_FOR_COURSE", // "open final reflection report for course csce 4901"

	GO_BACK: "GO_BACK",

	NAVIGATE_TO: "NAVIGATE_TO",
	READ_PAGE: "READ_PAGE",
	READ_NEXT: "READ_NEXT",
	REPEAT: "REPEAT",
	HELP: "HELP",
	AFFIRM: "AFFIRM",
	DENY: "DENY",
	UNKNOWN: "UNKNOWN",
	  // ✅ “Real helper” intents
	DUE_TODAY: "DUE_TODAY",
	DUE_THIS_WEEK: "DUE_THIS_WEEK",
	NEXT_DUE: "NEXT_DUE",
	OVERDUE: "OVERDUE",
	LIST_UPCOMING: "LIST_UPCOMING",
	OPEN_DASHBOARD: "OPEN_DASHBOARD",
	SMALL_TALK: "SMALL_TALK",
	QA_GENERAL: "QA_GENERAL",

};

// --- Utilities ---------------------------------------------------------------

export function normalize(text = "") {
	return String(text || "")
		.toLowerCase()
		.replace(/[“”"']/g, "")
		.replace(/[-_]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

const SYN = {
	grades: ["grades", "grade", "marks", "scores", "gradebook", "result", "results"],
	assignments: ["assignments", "assignment", "tasks", "homework", "hw", "to do", "to-do", "submissions"],
	courses: ["courses", "course", "classes", "subjects"],
	open: ["open", "go to", "navigate to", "take me to", "show me", "bring me to"],
	read: ["read", "speak", "say", "narrate"],
	next: ["next", "continue", "go on", "proceed", "keep reading"],
	repeat: ["repeat", "again", "say again", "one more time"],
	yes: ["yes", "yeah", "yep", "sure", "ok", "okay", "do it"],
	no: ["no", "nope", "nah", "dont", "don’t", "do not", "stop"],
	back: ["go back", "back", "previous", "last page", "return"],
	option: ["option", "choice", "pick"],
	sections: ["assignments", "grades", "modules", "announcements", "discussions", "quizzes", "files", "pages", "people"],

	// ✅ NEW: natural phrases seen in your test log
	home: ["home", "dashboard", "main page", "start page"],
	summarize: ["summarize", "summary", "sum up", "tl dr", "tldr", "overview"],
	document: ["document", "details", "instructions"],

	due: ["due", "deadline", "due date", "due today", "due this week", "due this weekend"],
	today: ["today", "tonight"],
	week: ["this week", "next 7 days", "next seven days", "upcoming week"],
	next: ["next", "coming up", "soonest", "nearest"],
	overdue: ["overdue", "late", "past due", "missed"],
	upcoming: ["upcoming", "coming up", "what's coming", "what is coming", "next items"],

};

function escapeReg(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function anySyn(key) {
	return SYN[key].map(escapeReg).join("|");
}

// Helps extract "csce 4901" even if ASR says "cse" or has extra filler words
function extractCourseNum(u) {
	const m = u.match(/\b(?:csce|cse|csc)\s*(\d{3,4})\b/i);
	if (m?.[1]) return m[1];
	const m2 = u.match(/\bcourse\s*(\d{3,4})\b/i);
	if (m2?.[1]) return m2[1];
	const m3 = u.match(/\b(\d{4})\b/);
	return m3?.[1] || null;
}

function stripCourseTail(u) {
	// remove "for course csce 4901" / "in csce 4901" / "for csce 4901"
	return u
		.replace(/\b(for|in|of)\b\s+(?:the\s+)?(?:course\s+)?(?:csce|cse|csc)?\s*\d{3,4}\b/gi, "")
		.replace(/\b(?:csce|cse|csc)\s*\d{3,4}\b/gi, "")
		.replace(/\s+/g, " ")
		.trim();
}

const RE = {
	openGrades: new RegExp(`\\b(${anySyn("open")})\\s+(my\\s+)?(${anySyn("grades")})\\b`),
	openAssignments: new RegExp(`\\b(${anySyn("open")})\\s+(my\\s+)?(${anySyn("assignments")})\\b`),
	openCourses: new RegExp(`\\b(${anySyn("open")})\\s+(my\\s+)?(${anySyn("courses")})\\b`),
    submitAssignment: /\b(submit|turn\s*in|upload)\b.*\b(assignment|submission)\b/,

	
	openDashboard: new RegExp(
		`\\b(${anySyn("open")})\\s+(my\\s+)?(${anySyn("home")})\\b|\\b(go\\s+home)\\b`
	),

	readPage: new RegExp(`\\b(${anySyn("read")})\\b.*\\b(page|this|content|everything)\\b|\\b(read the page)\\b`),
	readNext: new RegExp(`\\b(${anySyn("read")})\\b.*\\b(${anySyn("next")})\\b|\\b(${anySyn("next")})\\s+(part|section|one)\\b`),
	repeat: new RegExp(`\\b(${anySyn("repeat")})\\b`),

	// ✅ NEW: "summarize the page" / "summary of this" / "overview"
	summarizePage: new RegExp(
		`\\b(${anySyn("summarize")})\\b(?:\\s+the)?\\s+\\b(page|this|content|everything)\\b|\\b(summarize\\s+this)\\b`
	),

	// ✅ NEW: "read the document" / "read details"
	readDocument: new RegExp(`\\b(${anySyn("read")})\\b.*\\b(${anySyn("document")})\\b`),

	help: /\b(help|what can you do|how to|commands)\b/,

	affirm: new RegExp(`\\b(${anySyn("yes")})\\b`),
	deny: new RegExp(`\\b(${anySyn("no")})\\b`),

	goBack: new RegExp(`\\b(${anySyn("back")})\\b`),

	// choice like "option 1" / "pick 2" / "choice 3"
	chooseOption: new RegExp(`\\b(${anySyn("option")})\\s*(?<idx>\\d+|first|second|third|fourth|fifth)\\b`),

	// ✅ compound: "open assignments for course csce 4901"
	openAssignmentsForCourse:
		/\b(open|go to|navigate to|show)\b.*\b(assignments?|homework|tasks?)\b.*\b(for|in|of)\b.*\b(?:course\b)?\s*(?:csce|cse|csc)?\s*\d{3,4}\b/i,

	// ✅ compound: "open assignment final reflection report for course csce 4901"
	// Captures "assignment query" in the middle (anything between 'assignment' and 'for/in/of ... csce ####')
	openAssignmentForCourse:
		/\b(open|go to|navigate to|show)\b.*\bassignment\b.*\b(for|in|of)\b.*\b(?:course\b)?\s*(?:csce|cse|csc)?\s*\d{3,4}\b/i,

	// "open csce 3530" / "open cse 4901" / just "3530"
	openCourseByNumber:
		/\b(?:open|go to|navigate to|show)\s+(?:csce|cse|csc|course)?\s*(?<courseNum>\d{4})\b|\b(?:csce|cse|csc)\s*(?<courseNum2>\d{4})\b/,

	// "open assignments of csce 3530"
	openCourseSection: new RegExp(
		`\\b(?:open|go to|show|navigate to)\\s+(?<section>${anySyn("sections")})\\s+(?:of|for|in)\\s+(?:csce|cse|csc|course)?\\s*(?<courseNum>\\d{4})\\b`
	),

	// assignment query: "hw2", "hw 2", "homework 2", "assignment 2"
	openAssignmentQuery: /\b(hw|homework|assignment)\s*(?<q>\d+)\b/,

	// generic open <target>
	openGeneric: new RegExp(`\\b(${anySyn("open")})\\s+(?<target>.+)$`),

	kwGrades: new RegExp(`\\b(${anySyn("grades")})\\b`),
	kwAssignments: new RegExp(`\\b(${anySyn("assignments")})\\b`),
	kwCourses: new RegExp(`\\b(${anySyn("courses")})\\b`),
	kwReadNext: new RegExp(`\\b(${anySyn("next")})\\b`),

	dueToday: /\b(what('| i)?s|what is)?\s*(due|deadline)\s*(today|tonight)\b|\bdue\s*today\b/i,
	dueThisWeek: /\b(what('| i)?s|what is)?\s*(due|deadlines?)\s*(this week|next 7 days|next seven days)\b|\bdue\s*this\s*week\b/i,
	nextDue: /\b(what('| i)?s|what is)?\s*(next|soonest)\s*(due|deadline)\b|\bnext due\b/i,
	overdue: /\b(any|what('| i)?s|what is)?\s*(overdue|past due|late|missed)\b/i,
	listUpcoming: /\b(list|show|tell me)\s*(my\s*)?(upcoming|coming up)\b/i,

};

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

function scored(intent, confidence, slots = {}, reason = "") {
	return { intent, confidence, slots, reason };
}

export async function detectIntent(rawUtterance = "", context = {}) {
	const u = normalize(rawUtterance);
	if (!u) return scored(intents.UNKNOWN, 0.0, {}, "empty");

	// if we're expecting a choice, prioritize option parsing
	if (context?.expectingChoice) {
		const ch = u.match(RE.chooseOption);
		if (ch?.groups?.idx) return scored(intents.CHOOSE_OPTION, 0.92, { idx: ch.groups.idx }, "context: chooseOption");
		// still allow cancel
		if (RE.deny.test(u)) return scored(intents.DENY, 0.9, {}, "context: deny");
		return scored(intents.UNKNOWN, 0.4, {}, "context: expectingChoice but unclear");
	}

	// yes/no when asked
	if (context?.expectingYesNo) {
		if (RE.affirm.test(u)) return scored(intents.AFFIRM, 0.9, {}, "context: affirm");
		if (RE.deny.test(u)) return scored(intents.DENY, 0.9, {}, "context: deny");
	}

	// =============================================================================
	// ✅ Compound (multi-step) rules FIRST (must beat the course matcher)
	// =============================================================================

	// "open assignments for/in/of course csce 4901"
	if (RE.openAssignmentsForCourse.test(u)) {
		const courseNum = extractCourseNum(u);
		if (courseNum) return scored(intents.OPEN_ASSIGNMENTS_FOR_COURSE, 0.96, { courseNum }, "compound: assignmentsForCourse");
	}

	// "open assignment <something> for course csce 4901"
	// ex: "open assignment final reflection report for course csce 4901"
	// If the user says only "open assignment for course csce 4901" with no query,
	// we still route it here; actions.js should prompt "which assignment?"
	if (RE.openAssignmentForCourse.test(u)) {
		const courseNum = extractCourseNum(u);
		const q = stripCourseTail(u)
			.replace(/\b(open|go to|navigate to|show)\b/gi, "")
			.replace(/\bassignment\b/gi, "")
			.replace(/\s+/g, " ")
			.trim();

		if (courseNum) {
			return scored(
				intents.OPEN_ASSIGNMENT_FOR_COURSE,
				0.96,
				{ courseNum, q: q || "" },
				"compound: assignmentForCourse"
			);
		}
	}
	  // ✅ Real-helper queries
	if (RE.dueToday.test(u)) return scored(intents.DUE_TODAY, 0.95, {}, "rule: dueToday");
	if (RE.dueThisWeek.test(u)) return scored(intents.DUE_THIS_WEEK, 0.95, {}, "rule: dueThisWeek");
	if (RE.nextDue.test(u)) return scored(intents.NEXT_DUE, 0.92, {}, "rule: nextDue");
	if (RE.overdue.test(u)) return scored(intents.OVERDUE, 0.92, {}, "rule: overdue");
	if (RE.listUpcoming.test(u)) return scored(intents.LIST_UPCOMING, 0.88, {}, "rule: listUpcoming");


	// =============================================================================
	// Existing one-shot rules
	// =============================================================================

	// course section one-shot (non-compound)
	const cs = u.match(RE.openCourseSection);
	if (cs?.groups?.courseNum && cs?.groups?.section) {
		return scored(
			intents.OPEN_COURSE_SECTION,
			0.93,
			{ courseNum: cs.groups.courseNum, section: cs.groups.section },
			"rule: openCourseSection"
		);
	}

	// strong rules
	if (RE.openGrades.test(u)) return scored(intents.OPEN_GRADES, 0.98, {}, "rule: openGrades");
	if (RE.submitAssignment.test(u)) return scored(intents.SUBMIT_ASSIGNMENT, 0.97, {}, "rule: submitAssignment");
	if (RE.openAssignments.test(u)) return scored(intents.OPEN_ASSIGNMENTS, 0.97, {}, "rule: openAssignments");
	if (RE.openCourses.test(u)) return scored(intents.OPEN_COURSES, 0.96, {}, "rule: openCourses");

	// ✅ NEW: dashboard/home
	if (RE.openDashboard.test(u)) return scored(intents.OPEN_DASHBOARD, 0.96, {}, "rule: openDashboard");

	// ✅ NEW: summarize / read document -> treat as READ_PAGE for now
	if (RE.summarizePage.test(u)) return scored(intents.READ_PAGE, 0.93, {}, "rule: summarizePage");
	if (RE.readDocument.test(u)) return scored(intents.READ_PAGE, 0.93, {}, "rule: readDocument");

	if (RE.readPage.test(u)) return scored(intents.READ_PAGE, 0.95, {}, "rule: readPage");
	if (RE.readNext.test(u)) return scored(intents.READ_NEXT, 0.93, {}, "rule: readNext");
	if (RE.repeat.test(u)) return scored(intents.REPEAT, 0.9, {}, "rule: repeat");
	if (RE.help.test(u)) return scored(intents.HELP, 0.9, {}, "rule: help");
	if (RE.goBack.test(u)) return scored(intents.GO_BACK, 0.92, {}, "rule: goBack");

	// assignment query (numeric)
	const am = u.match(RE.openAssignmentQuery);
	if (am?.groups?.q) {
		const q = `HW ${am.groups.q}`;
		return scored(intents.OPEN_ASSIGNMENT_QUERY, 0.9, { q }, "rule: openAssignmentQuery");
	}

	// course by number
	const cm = u.match(RE.openCourseByNumber);
	const courseNum = cm?.groups?.courseNum || cm?.groups?.courseNum2;
	if (courseNum) return scored(intents.OPEN_COURSE_BY_NUMBER, 0.92, { courseNum }, "rule: openCourseByNumber");

	// generic open <target>
	const og = u.match(RE.openGeneric);
	if (og?.groups?.target) {
		const target = og.groups.target.trim();
		return scored(intents.NAVIGATE_TO, 0.8, { target }, "rule: openGeneric");
	}

	// keyword fallbacks
	if (RE.kwGrades.test(u)) return scored(intents.OPEN_GRADES, 0.7, {}, "kw: grades");
	if (RE.kwAssignments.test(u)) return scored(intents.OPEN_ASSIGNMENTS, 0.7, {}, "kw: assignments");
	if (RE.kwCourses.test(u)) return scored(intents.OPEN_COURSES, 0.65, {}, "kw: courses");
	if (RE.kwReadNext.test(u)) return scored(intents.READ_NEXT, 0.6, {}, "kw: next");
	// =============================================================================
	// ✅ LLM fallback (dynamic phrasing + small talk + general questions)
	// Only run when rules are uncertain.
	// =============================================================================

	// If we got here, the rule engine didn't feel confident.
	// Ask the LLM to route it (fast + robust).
	const allowIntents = [
		// Navigation / Canvas actions
		intents.OPEN_DASHBOARD,
		intents.OPEN_COURSES,
		intents.OPEN_ASSIGNMENTS,
		intents.OPEN_GRADES,
		intents.GO_BACK,
		intents.NAVIGATE_TO,
		intents.READ_PAGE,
		intents.READ_NEXT,
		intents.REPEAT,
		intents.HELP,
		intents.AFFIRM,
		intents.DENY,

		// Course + assignment targeting
		intents.OPEN_COURSE_BY_NUMBER,
		intents.OPEN_COURSE_SECTION,
		intents.OPEN_ASSIGNMENT_QUERY,
		intents.OPEN_ASSIGNMENTS_FOR_COURSE,
		intents.OPEN_ASSIGNMENT_FOR_COURSE,

		// “real helper” queries
		intents.DUE_TODAY,
		intents.DUE_THIS_WEEK,
		intents.NEXT_DUE,
		intents.OVERDUE,
		intents.LIST_UPCOMING,

		// Conversational
		intents.SMALL_TALK,
		intents.QA_GENERAL,
		intents.UNKNOWN,
	];

	const llm = await llmClassifyIntent({ utterance: rawUtterance, allowIntents, context });

	if (llm?.intent) {
		// Slightly down-weight overconfident LLM answers (keeps safety)
		const conf = Math.min(0.9, Math.max(0.35, Number(llm.confidence || 0.5)));
		return scored(llm.intent, conf, llm.slots || {}, `llm: ${llm.reason || "router"}`);
	}

	return scored(intents.UNKNOWN, 0.25, {}, "default");
}
