// lib/actions.js
// PERSON B — Action router for detected intents.
// Depends on intent enums + Memory from lib/intent.js

import { intents, Memory, normalize } from "./intent.js";

// ---- Speech helpers ---------------------------------------------------------

export function speak(text, opts = {}) {
    return new Promise((resolve) => {
        try {
            const utter = new SpeechSynthesisUtterance(text);
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

// ---- DOM utils --------------------------------------------------------------

function allLinks() {
	return Array.from(document.querySelectorAll("a, [role='link']"));
}

function scoreLink(el, keywords = [], hrefHints = []) {
	const text = (el.textContent || "").trim().toLowerCase();
	const href = (el.getAttribute?.("href") || "").toLowerCase();
	let score = 0;

	for (const k of keywords) {
		if (text.includes(k)) score += 2.5;
		if (href.includes(k)) score += 1.2;
	}
	for (const h of hrefHints) {
		if (href.includes(h)) score += 1.5;
	}

	// Visibility/size bonus
	const rect = el.getBoundingClientRect?.();
	if (rect && rect.width > 40 && rect.height > 16) score += 0.4;

	// Landmark bonus (Canvas left nav etc.)
	if (el.closest?.("#section-tabs, #left-side, .ic-app-nav")) score += 0.6;

	return score;
}

/**
 * findBestLink
 * Robustly finds a link on Canvas-style pages by text and href hints.
 */
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

// Try to chunk the page into "sections" for reading
function getReadableSections() {
	// Prefer headings and ARIA landmarks
	const selectors = [
		"main h1, main h2, main h3, main h4",
		"article h1, article h2, article h3, article h4",
		"[role='main'] h1, [role='main'] h2, [role='main'] h3, [role='main'] h4",
		".ic-Layout-main h1, .ic-Layout-main h2, .ic-Layout-main h3, .ic-Layout-main h4",
	];
	const heads = Array.from(document.querySelectorAll(selectors.join(", ")));
	if (heads.length === 0) {
		// vanilla fallback: large blocks
		const blocks = Array.from(document.querySelectorAll("main p, article p, [role='main'] p"));
		return blocks.map((b, i) => ({ id: b.id || `p-${i}`, el: b }));
	}
	return heads.map((h, i) => ({ id: h.id || `sec-${i}`, el: h }));
}

// ---- Action handlers --------------------------------------------------------

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

async function actOpenGrades() {
	const link = findBestLink({
		keywords: ["grades", "grade", "marks", "score", "results"],
		hrefHints: ["/grades"],
	});
	if (link) {
		const label = (link.textContent || "Grades").trim();
		clickAndNavigate(link);
		speak(`Opening ${label}.`);
		await remember({ lastIntent: intents.OPEN_GRADES, lastLinkText: label, lastLinkHref: link.href });
		return { ok: true, message: `Opened: ${label}` };
	}
	// fallback: ask to search/read
	speak("I couldn't find Grades here. Do you want me to read the page instead?");
	await remember({ expectingYesNo: true, pendingAction: "READ_PAGE" });
	return { ok: false, message: "Grades link not found" };
}

async function actOpenAssignments() {
	const link = findBestLink({
		keywords: ["assignments", "assignment", "tasks", "homework", "to do", "to-do"],
		hrefHints: ["/assignments"],
	});
	if (link) {
		const label = (link.textContent || "Assignments").trim();
		clickAndNavigate(link);
		speak(`Opening ${label}.`);
		await remember({ lastIntent: intents.OPEN_ASSIGNMENTS, lastLinkText: label, lastLinkHref: link.href });
		return { ok: true, message: `Opened: ${label}` };
	}
	speak("I couldn't find Assignments here. Should I read the page?");
	await remember({ expectingYesNo: true, pendingAction: "READ_PAGE" });
	return { ok: false, message: "Assignments link not found" };
}

async function actOpenCourses() {
	const link = findBestLink({
		keywords: ["courses", "course", "classes", "dashboard"],
		hrefHints: ["/courses", "/dashboard"],
	});
	if (link) {
		const label = (link.textContent || "Courses").trim();
		clickAndNavigate(link);
		speak(`Opening ${label}.`);
		await remember({ lastIntent: intents.OPEN_COURSES, lastLinkText: label, lastLinkHref: link.href });
		return { ok: true, message: `Opened: ${label}` };
	}
	speak("I couldn't find Courses on this page. Want me to read the content for you?");
	await remember({ expectingYesNo: true, pendingAction: "READ_PAGE" });
	return { ok: false, message: "Courses link not found" };
}

async function actNavigateTo(targetRaw) {
	const target = normalize(targetRaw);
	const words = target.split(" ").filter(Boolean);

	const link = findBestLink({
		keywords: words,
		hrefHints: ["/grades", "/assignments", "/courses", "/modules", "/quizzes", "/files", "/calendar"],
	});

	if (link) {
		const label = (link.textContent || targetRaw).trim();
		clickAndNavigate(link);
		speak(`Opening ${label}.`);
		await remember({ lastIntent: intents.NAVIGATE_TO, lastLinkText: label, lastLinkHref: link.href });
		return { ok: true, message: `Opened: ${label}` };
	}
	speak(`I couldn't find ${targetRaw}. Should I read the page for clues?`);
	await remember({ expectingYesNo: true, pendingAction: "READ_PAGE" });
	return { ok: false, message: `Target not found: ${targetRaw}` };
}

function textFromNode(el) {
	if (!el) return "";
	// Combine header + its immediate paragraph siblings as a “section”
	let t = (el.textContent || "").trim();
	let sib = el.nextElementSibling;
	let steps = 0;
	while (sib && steps < 3 && /^(P|UL|OL|DIV|SECTION)$/i.test(sib.tagName)) {
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
		const chunk = all.slice(0, 1000);
		speak("Reading the page.");
		speak(chunk);
		await remember({ lastIntent: intents.READ_PAGE, lastSectionId: null, expectingYesNo: false, pendingAction: null });
		return { ok: true, message: "Read page (fallback blob)" };
	}

	const first = secs[0];
	const out = textFromNode(first.el).slice(0, 1200);
	speak("Reading the first section.");
	speak(out);
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
		speak("I don't see sections on this page. Do you want me to read everything?");
		await remember({ expectingYesNo: true, pendingAction: "READ_PAGE" });
		return { ok: false, message: "No sections" };
	}

	let idx = 0;
	if (lastId) {
		idx = Math.max(0, secs.findIndex((s) => s.id === lastId) + 1);
	}

	if (idx >= secs.length) {
		speak("You're at the end of the page.");
		await remember({ expectingYesNo: false, pendingAction: null });
		return { ok: false, message: "End of sections" };
	}

	const sec = secs[idx];
	const out = textFromNode(sec.el).slice(0, 1200);
	speak("Reading the next section.");
	speak(out);
	await remember({ lastIntent: intents.READ_NEXT, lastSectionId: sec.id, expectingYesNo: false, pendingAction: null });
	return { ok: true, message: `Read section: ${sec.id}` };
}

async function actRepeat() {
	const state = await mem.get();
	// Repeat last spoken anchor if available; otherwise re-read page header
	if (state.lastSectionId) {
		const el = document.getElementById(state.lastSectionId);
		if (el) {
			const out = textFromNode(el).slice(0, 1200);
			speak("Repeating.");
			speak(out);
			return { ok: true, message: `Repeated section: ${state.lastSectionId}` };
		}
	}
	const h1 = document.querySelector("main h1, [role='main'] h1, h1");
	const title = (h1?.textContent || document.title || "this page").trim();
	speak(`Repeating: ${title}.`);
	return { ok: true, message: "Repeated title" };
}

async function actHelp() {
	const msg =
		"You can say: Open my grades. Open assignments. Open courses. Read the page. Read the next part. Repeat. If I miss something, say help.";
	speak(msg);
	return { ok: true, message: "Help spoken" };
}

async function actAffirmDeny(isYes) {
	const state = await mem.get();
	if (!state.expectingYesNo) {
		speak(isYes ? "Okay." : "Alright.");
		return { ok: true, message: "Ambient yes/no" };
	}
	const pending = state.pendingAction;
	await remember({ expectingYesNo: false }); // clear question mode

	if (isYes && pending === "READ_PAGE") {
		return await actReadPage();
	}
	speak("Okay, canceled.");
	return { ok: true, message: "Canceled pending action" };
}

// ---- Router ---------------------------------------------------------------

export async function runAction(intent, slots = {}) {
	switch (intent) {
		case intents.OPEN_GRADES:
			return await actOpenGrades();
		case intents.OPEN_ASSIGNMENTS:
			return await actOpenAssignments();
		case intents.OPEN_COURSES:
			return await actOpenCourses();
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
		default:
			// Fallback dialog
			speak("I didn’t catch that. Do you want me to read the page?");
			await remember({ expectingYesNo: true, pendingAction: "READ_PAGE", lastIntent: intents.UNKNOWN });
			return { ok: false, message: "Unknown intent; asked fallback question" };
	}
}

// ---- Convenience: one-shot pipeline ----------------------------------------

/**
 * handleUtterance
 * @param {string} utterance
 * @param {function} nluDetect  optional custom NLU (signature like detectIntent)
 * @returns {object} { intent, result }
 */
export async function handleUtterance(utterance, nluDetect) {
	const detector = nluDetect ?? (await import("./intent.js")).detectIntent;
	const context = await mem.get();
	const { intent, slots, confidence, reason } = await detector(utterance, context);

	// Optional: low-confidence guard before destructive actions (here we proceed with fallback in router)
	if (confidence < 0.45 && intent !== intents.HELP) {
		// ask permission to read as discovery
		speak("I’m not sure I understood. Do you want me to read the page?");
		await mem.set({ expectingYesNo: true, pendingAction: "READ_PAGE", lastIntent: intents.UNKNOWN });
		return { intent, result: { ok: false, message: "Low confidence", confidence, reason } };
	}

	const result = await runAction(intent, slots);
	// keep a small trace
	await mem.set({ lastHeard: utterance, lastIntent: intent });
	return { intent, result: { ...result, confidence, reason } };
}
