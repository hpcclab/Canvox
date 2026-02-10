// lib/intent.js
// PERSON B — Natural Language & Intent Brain (NLU core)
import { llmClassifyIntent } from "./tiny_llm.js";

export const intents = {
	// Core navigation
	OPEN_DASHBOARD: "OPEN_DASHBOARD", // Canvas global dashboard (/dashboard)
	OPEN_HOME: "OPEN_HOME", // Course Home (when inside a course) OR "Home" link
	OPEN_COURSES: "OPEN_COURSES",
	OPEN_GRADES: "OPEN_GRADES",
	OPEN_ASSIGNMENTS: "OPEN_ASSIGNMENTS",
	OPEN_MODULES: "OPEN_MODULES",
	OPEN_QUIZZES: "OPEN_QUIZZES",
	OPEN_FILES: "OPEN_FILES",
	GO_BACK: "GO_BACK",
	NAVIGATE_TO: "NAVIGATE_TO",

	// Actions
	SUBMIT_ASSIGNMENT: "SUBMIT_ASSIGNMENT",

	// Targeting
	OPEN_COURSE_BY_NUMBER: "OPEN_COURSE_BY_NUMBER",
	OPEN_COURSE_SECTION: "OPEN_COURSE_SECTION", // e.g., "open assignments of csce 3530"
	OPEN_ASSIGNMENT_QUERY: "OPEN_ASSIGNMENT_QUERY", // e.g., "open hw 2"
	CHOOSE_OPTION: "CHOOSE_OPTION",

	// Compound / multi-step intents
	OPEN_ASSIGNMENTS_FOR_COURSE: "OPEN_ASSIGNMENTS_FOR_COURSE",
	OPEN_ASSIGNMENT_FOR_COURSE: "OPEN_ASSIGNMENT_FOR_COURSE",

	// Reading
	READ_PAGE: "READ_PAGE",
	READ_NEXT: "READ_NEXT",
	REPEAT: "REPEAT",
	HELP: "HELP",

	// Confirmations
	AFFIRM: "AFFIRM",
	DENY: "DENY",

	// “Real helper” intents
	DUE_TODAY: "DUE_TODAY",
	DUE_THIS_WEEK: "DUE_THIS_WEEK",
	NEXT_DUE: "NEXT_DUE",
	OVERDUE: "OVERDUE",
	LIST_UPCOMING: "LIST_UPCOMING",

	// Conversational
	SMALL_TALK: "SMALL_TALK",
	QA_GENERAL: "QA_GENERAL",

	UNKNOWN: "UNKNOWN",
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
	// verbs
	open: ["open", "go to", "navigate to", "take me to", "show me", "bring me to", "go"],

	// sections
	grades: ["grades", "grade", "marks", "scores", "gradebook", "result", "results"],
	assignments: ["assignments", "assignment", "tasks", "homework", "hw", "to do", "to-do", "submissions"],
	modules: ["modules", "module"],
	quizzes: ["quizzes", "quiz"],
	files: ["files", "file"],
	courses: ["courses", "course", "classes", "subjects"],

	// reading
	read: ["read", "speak", "say", "narrate"],
	nextRead: ["next", "continue", "go on", "proceed", "keep reading"],
	repeat: ["repeat", "again", "say again", "one more time"],

	// confirm
	yes: ["yes", "yeah", "yep", "sure", "ok", "okay", "do it"],
	no: ["no", "nope", "nah", "dont", "don’t", "do not", "stop", "cancel", "nevermind", "never mind"],
	back: ["go back", "back", "previous", "last page", "return", "goback"],

	// choice
	option: ["option", "choice", "pick"],

	// IMPORTANT: keep dashboard vs home separate
	dashboard: ["dashboard"],
	home: ["home"],

	// extra
	summarize: ["summarize", "summary", "sum up", "tl dr", "tldr", "overview"],
	document: ["document", "details", "instructions"],

	// due helpers
	due: ["due", "deadline", "due date", "due today", "due this week", "due this weekend"],
};

function escapeReg(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function anySyn(key) {
	return (SYN[key] || []).map(escapeReg).join("|");
}

// Helps extract "csce 4901" even if ASR says "cse/csc/cs" etc.
function extractCourseNum(u) {
	const m =
		u.match(/\b(?:csce|cse|csc|cscE|cs|c s c e)\s*(\d{3,4})\b/i) ||
		u.match(/\bcourse\s*(\d{3,4})\b/i) ||
		u.match(/\b(\d{4})\b/);
	return m?.[1] || null;
}

function stripCourseTail(u) {
	// remove "for course csce 4901" / "in csce 4901" / "for csce 4901"
	return u
		.replace(/\b(for|in|of)\b\s+(?:the\s+)?(?:course\s+)?(?:csce|cse|csc|cs)?\s*\d{3,4}\b/gi, "")
		.replace(/\b(?:csce|cse|csc|cs)\s*\d{3,4}\b/gi, "")
		.replace(/\s+/g, " ")
		.trim();
}

const RE = {
	// strong section opens
	openGrades: new RegExp(`\\b(${anySyn("open")})\\s+(my\\s+)?(${anySyn("grades")})\\b`, "i"),
	openAssignments: new RegExp(`\\b(${anySyn("open")})\\s+(my\\s+)?(${anySyn("assignments")})\\b`, "i"),
	openModules: new RegExp(`\\b(${anySyn("open")})\\s+(my\\s+)?(${anySyn("modules")})\\b`, "i"),
	openQuizzes: new RegExp(`\\b(${anySyn("open")})\\s+(my\\s+)?(${anySyn("quizzes")})\\b`, "i"),
	openFiles: new RegExp(`\\b(${anySyn("open")})\\s+(my\\s+)?(${anySyn("files")})\\b`, "i"),
	openCourses: new RegExp(`\\b(${anySyn("open")})\\s+(my\\s+)?(${anySyn("courses")})\\b`, "i"),

	submitAssignment: /\b(submit|turn\s*in|upload)\b.*\b(assignment|submission)\b/i,

	// dashboard vs home (separate!)
	openDashboard: new RegExp(`\\b(${anySyn("open")})\\s+(my\\s+)?(${anySyn("dashboard")})\\b`, "i"),
	openHome: new RegExp(`\\b(${anySyn("open")})\\s+(my\\s+)?(${anySyn("home")})\\b|\\b(go\\s+home)\\b`, "i"),

	// reading
	readPage: new RegExp(`\\b(${anySyn("read")})\\b.*\\b(page|this|content|everything)\\b|\\b(read the page)\\b`, "i"),
	readNext: new RegExp(
		`\\b(${anySyn("read")})\\b.*\\b(${anySyn("nextRead")})\\b|\\b(${anySyn("nextRead")})\\s+(part|section|one)\\b`,
		"i"
	),
	repeat: new RegExp(`\\b(${anySyn("repeat")})\\b`, "i"),

	summarizePage: new RegExp(
		`\\b(${anySyn("summarize")})\\b(?:\\s+the)?\\s+\\b(page|this|content|everything)\\b|\\b(summarize\\s+this)\\b`,
		"i"
	),
	readDocument: new RegExp(`\\b(${anySyn("read")})\\b.*\\b(${anySyn("document")})\\b`, "i"),

	help: /\b(help|what can you do|how to|commands)\b/i,

	affirm: new RegExp(`\\b(${anySyn("yes")})\\b`, "i"),
	deny: new RegExp(`\\b(${anySyn("no")})\\b`, "i"),
	goBack: new RegExp(`\\b(${anySyn("back")})\\b`, "i"),

	// choice like "option 1" / "pick 2"
	chooseOption: new RegExp(`\\b(${anySyn("option")})\\s*(?<idx>\\d+|first|second|third|fourth|fifth)\\b`, "i"),

	// compound: "open assignments for course csce 4901"
	openAssignmentsForCourse:
		/\b(open|go|go to|navigate to|show)\b.*\b(assignments?|homework|tasks?)\b.*\b(for|in|of)\b.*\b(?:course\b)?\s*(?:csce|cse|csc|cs)?\s*\d{3,4}\b/i,

	// compound: "open assignment <something> for course csce 4901"
	openAssignmentForCourse:
		/\b(open|go|go to|navigate to|show)\b.*\bassignment\b.*\b(for|in|of)\b.*\b(?:course\b)?\s*(?:csce|cse|csc|cs)?\s*\d{3,4}\b/i,

	// "open csce 3530" / "open course 3530" / just "3530" (when used with open/go)
	openCourseByNumber:
		/\b(?:open|go|go to|navigate to|show)\s+(?:csce|cse|csc|cs|course)?\s*(?<courseNum>\d{4})\b|\b(?:csce|cse|csc|cs)\s*(?<courseNum2>\d{4})\b/i,

	// "open assignments of csce 3530"
	openCourseSection: new RegExp(
		`\\b(?:open|go|go to|show|navigate to)\\s+(?<section>assignments|grades|modules|announcements|discussions|quizzes|files|pages|people)\\s+(?:of|for|in)\\s+(?:csce|cse|csc|cs|course)?\\s*(?<courseNum>\\d{4})\\b`,
		"i"
	),

	// assignment query: "hw2", "hw 2", "homework 2", "assignment 2"
	openAssignmentQuery: /\b(hw|homework|assignment)\s*(?<q>\d+)\b/i,

	// generic open <target>
	openGeneric: new RegExp(`\\b(${anySyn("open")})\\s+(?<target>.+)$`, "i"),

	// keyword fallbacks
	kwGrades: new RegExp(`\\b(${anySyn("grades")})\\b`, "i"),
	kwAssignments: new RegExp(`\\b(${anySyn("assignments")})\\b`, "i"),
	kwCourses: new RegExp(`\\b(${anySyn("courses")})\\b`, "i"),
	kwDashboard: new RegExp(`\\b(${anySyn("dashboard")})\\b`, "i"),
	kwHome: new RegExp(`\\b(${anySyn("home")})\\b`, "i"),
	kwReadNext: new RegExp(`\\b(${anySyn("nextRead")})\\b`, "i"),

	// due queries
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

	// If expecting a choice, prioritize option parsing
	if (context?.expectingChoice) {
		const ch = u.match(RE.chooseOption);
		if (ch?.groups?.idx) return scored(intents.CHOOSE_OPTION, 0.92, { idx: ch.groups.idx }, "context: chooseOption");
		if (RE.deny.test(u)) return scored(intents.DENY, 0.9, {}, "context: deny");
		return scored(intents.UNKNOWN, 0.4, {}, "context: expectingChoice but unclear");
	}

	// Yes/no when asked
	if (context?.expectingYesNo) {
		if (RE.affirm.test(u)) return scored(intents.AFFIRM, 0.9, {}, "context: affirm");
		if (RE.deny.test(u)) return scored(intents.DENY, 0.9, {}, "context: deny");
	}

	// -------------------------------------------------------------------------
	// Compound (multi-step) rules FIRST (must beat the course matcher)
	// -------------------------------------------------------------------------
	if (RE.openAssignmentsForCourse.test(u)) {
		const courseNum = extractCourseNum(u);
		if (courseNum) return scored(intents.OPEN_ASSIGNMENTS_FOR_COURSE, 0.96, { courseNum }, "compound: assignmentsForCourse");
	}

	if (RE.openAssignmentForCourse.test(u)) {
		const courseNum = extractCourseNum(u);
		const q = stripCourseTail(u)
			.replace(/\b(open|go|go to|navigate to|show)\b/gi, "")
			.replace(/\bassignment\b/gi, "")
			.replace(/\s+/g, " ")
			.trim();

		if (courseNum) {
			return scored(intents.OPEN_ASSIGNMENT_FOR_COURSE, 0.96, { courseNum, q: q || "" }, "compound: assignmentForCourse");
		}
	}

	// “Real helper” queries
	if (RE.dueToday.test(u)) return scored(intents.DUE_TODAY, 0.95, {}, "rule: dueToday");
	if (RE.dueThisWeek.test(u)) return scored(intents.DUE_THIS_WEEK, 0.95, {}, "rule: dueThisWeek");
	if (RE.nextDue.test(u)) return scored(intents.NEXT_DUE, 0.92, {}, "rule: nextDue");
	if (RE.overdue.test(u)) return scored(intents.OVERDUE, 0.92, {}, "rule: overdue");
	if (RE.listUpcoming.test(u)) return scored(intents.LIST_UPCOMING, 0.88, {}, "rule: listUpcoming");

	// One-shot: "open assignments of csce 3530"
	const cs = u.match(RE.openCourseSection);
	if (cs?.groups?.courseNum && cs?.groups?.section) {
		return scored(intents.OPEN_COURSE_SECTION, 0.93, { courseNum: cs.groups.courseNum, section: cs.groups.section }, "rule: openCourseSection");
	}

	// Strong rules
	if (RE.openDashboard.test(u)) return scored(intents.OPEN_DASHBOARD, 0.98, {}, "rule: openDashboard");
	if (RE.openHome.test(u)) return scored(intents.OPEN_HOME, 0.95, {}, "rule: openHome");

	if (RE.openGrades.test(u)) return scored(intents.OPEN_GRADES, 0.98, {}, "rule: openGrades");
	if (RE.submitAssignment.test(u)) return scored(intents.SUBMIT_ASSIGNMENT, 0.97, {}, "rule: submitAssignment");
	if (RE.openAssignments.test(u)) return scored(intents.OPEN_ASSIGNMENTS, 0.97, {}, "rule: openAssignments");
	if (RE.openModules.test(u)) return scored(intents.OPEN_MODULES, 0.97, {}, "rule: openModules");
	if (RE.openQuizzes.test(u)) return scored(intents.OPEN_QUIZZES, 0.97, {}, "rule: openQuizzes");
	if (RE.openFiles.test(u)) return scored(intents.OPEN_FILES, 0.97, {}, "rule: openFiles");
	if (RE.openCourses.test(u)) return scored(intents.OPEN_COURSES, 0.96, {}, "rule: openCourses");

	// Summarize/read-doc -> READ_PAGE for now
	if (RE.summarizePage.test(u)) return scored(intents.READ_PAGE, 0.93, {}, "rule: summarizePage");
	if (RE.readDocument.test(u)) return scored(intents.READ_PAGE, 0.93, {}, "rule: readDocument");

	if (RE.readPage.test(u)) return scored(intents.READ_PAGE, 0.95, {}, "rule: readPage");
	if (RE.readNext.test(u)) return scored(intents.READ_NEXT, 0.93, {}, "rule: readNext");
	if (RE.repeat.test(u)) return scored(intents.REPEAT, 0.9, {}, "rule: repeat");
	if (RE.help.test(u)) return scored(intents.HELP, 0.9, {}, "rule: help");
	if (RE.goBack.test(u)) return scored(intents.GO_BACK, 0.92, {}, "rule: goBack");

	// Assignment query (numeric)
	const am = u.match(RE.openAssignmentQuery);
	if (am?.groups?.q) return scored(intents.OPEN_ASSIGNMENT_QUERY, 0.9, { q: `HW ${am.groups.q}` }, "rule: openAssignmentQuery");

	// Course by number
	const cm = u.match(RE.openCourseByNumber);
	const courseNum = cm?.groups?.courseNum || cm?.groups?.courseNum2;
	if (courseNum) return scored(intents.OPEN_COURSE_BY_NUMBER, 0.92, { courseNum }, "rule: openCourseByNumber");

	// Generic open <target>
	const og = u.match(RE.openGeneric);
	if (og?.groups?.target) {
		const target = og.groups.target.trim();
		return scored(intents.NAVIGATE_TO, 0.8, { target }, "rule: openGeneric");
	}

	// Keyword fallbacks (helpful for “go dashboard” etc.)
	if (RE.kwDashboard.test(u)) return scored(intents.OPEN_DASHBOARD, 0.75, {}, "kw: dashboard");
	if (RE.kwHome.test(u)) return scored(intents.OPEN_HOME, 0.72, {}, "kw: home");
	if (RE.kwGrades.test(u)) return scored(intents.OPEN_GRADES, 0.7, {}, "kw: grades");
	if (RE.kwAssignments.test(u)) return scored(intents.OPEN_ASSIGNMENTS, 0.7, {}, "kw: assignments");
	if (RE.kwCourses.test(u)) return scored(intents.OPEN_COURSES, 0.65, {}, "kw: courses");
	if (RE.kwReadNext.test(u)) return scored(intents.READ_NEXT, 0.6, {}, "kw: next");

	// -------------------------------------------------------------------------
	// LLM fallback (only when rules are uncertain)
	// -------------------------------------------------------------------------
	const allowIntents = [
		intents.OPEN_DASHBOARD,
		intents.OPEN_HOME,
		intents.OPEN_COURSES,
		intents.OPEN_ASSIGNMENTS,
		intents.OPEN_GRADES,
		intents.OPEN_MODULES,
		intents.OPEN_QUIZZES,
		intents.OPEN_FILES,
		intents.GO_BACK,
		intents.NAVIGATE_TO,
		intents.READ_PAGE,
		intents.READ_NEXT,
		intents.REPEAT,
		intents.HELP,
		intents.AFFIRM,
		intents.DENY,

		intents.OPEN_COURSE_BY_NUMBER,
		intents.OPEN_COURSE_SECTION,
		intents.OPEN_ASSIGNMENT_QUERY,
		intents.OPEN_ASSIGNMENTS_FOR_COURSE,
		intents.OPEN_ASSIGNMENT_FOR_COURSE,

		intents.DUE_TODAY,
		intents.DUE_THIS_WEEK,
		intents.NEXT_DUE,
		intents.OVERDUE,
		intents.LIST_UPCOMING,

		intents.SMALL_TALK,
		intents.QA_GENERAL,
		intents.UNKNOWN,
	];

	const llm = await llmClassifyIntent({ utterance: rawUtterance, allowIntents, context });

	if (llm?.intent) {
		const conf = Math.min(0.9, Math.max(0.35, Number(llm.confidence || 0.5)));
		return scored(llm.intent, conf, llm.slots || {}, `llm: ${llm.reason || "router"}`);
	}

	return scored(intents.UNKNOWN, 0.25, {}, "default");
}
