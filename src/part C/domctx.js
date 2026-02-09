// src/part c/domctx.js
"use strict";

/**
 * PageContext describes the important stuff we can read.
 *m
 * type: 'assignment' | 'announcement' | 'course_home' | 'generic'
 * sections: [{ id, heading, text }]
 */
export function getPageContext(doc = document, url = location.href) {
	const ctx = {
		type: "generic",
		title: null,
		courseName: null,
		dueDate: null,
		sections: [],
		rawHtml: null,
		url,
	};

	// Decide what kind of Canvas page this is
	if (/\/courses\/\d+\/assignments\//.test(url)) {
		return getAssignmentContext(doc, ctx);
	}
	if (/\/courses\/\d+\/announcements\//.test(url)) {
		return getAnnouncementContext(doc, ctx);
	}
	if (/\/courses\/\d+\/home/.test(url) || /\/courses\/\d+\/?$/.test(url)) {
		return getCourseHomeContext(doc, ctx);
	}

	return getGenericContext(doc, ctx);
}

function normalize(text) {
	return (text || "").replace(/\s+/g, " ").trim();
}

// ===== ASSIGNMENT PAGES =====
function getAssignmentContext(doc, base) {
	const ctx = { ...base, type: "assignment" };

	// Assignment title (usually an <h1>)
	const h1 = doc.querySelector("h1");
	ctx.title = normalize(h1?.textContent);

	// Course name (Canvas breadcrumbs)
	const breadcrumbCourse =
		doc.querySelector('[aria-label="Breadcrumbs"] a') || doc.querySelector(".ic-app-course-menu__header-title");
	ctx.courseName = normalize(breadcrumbCourse?.textContent);

	// Due date: Canvas has a few possible patterns
	const dueElement =
		doc.querySelector('[data-testid="assignment-due-date"]') ||
		doc.querySelector(".assignment-date-due") ||
		doc.querySelector(".submissionDetails .due_date") ||
		doc.querySelector('[data-testid="assignment-student-header-due-date"]');

	ctx.dueDate = normalize(dueElement?.textContent);

	// Main instructions / description
	const descElement =
		doc.querySelector('[data-testid="assignment-description"]') ||
		doc.querySelector(".description") ||
		doc.querySelector("#assignment_show .student-content") ||
		doc.querySelector("article");

	const descriptionText = normalize(descElement?.innerText || descElement?.textContent || "");

	if (descriptionText) {
		ctx.sections.push({
			id: "instructions",
			heading: "Instructions",
			text: descriptionText,
		});
	}

	// Rubric, if present
	const rubric =
		doc.querySelector("#rubric_full") ||
		doc.querySelector(".rubric_container") ||
		doc.querySelector('[data-testid="rubric"]');

	if (rubric) {
		const rubricText = normalize(rubric.innerText || rubric.textContent || "");
		if (rubricText) {
			ctx.sections.push({
				id: "rubric",
				heading: "Rubric",
				text: rubricText,
			});
		}
	}

	ctx.rawHtml = descElement?.innerHTML || null;
	return ctx;
}

// ===== ANNOUNCEMENTS =====
function getAnnouncementContext(doc, base) {
	const ctx = { ...base, type: "announcement" };

	const h1 = doc.querySelector("h1");
	ctx.title = normalize(h1?.textContent);

	const main =
		doc.querySelector('[data-testid="announcement-content"]') ||
		doc.querySelector(".ic-Announcement__content") ||
		doc.querySelector("article") ||
		doc.querySelector("main");

	const text = normalize(main?.innerText || main?.textContent || "");
	if (text) {
		ctx.sections.push({
			id: "body",
			heading: "Announcement",
			text,
		});
	}

	ctx.rawHtml = main?.innerHTML || null;
	return ctx;
}

// ===== COURSE HOME =====
function getCourseHomeContext(doc, base) {
	const ctx = { ...base, type: "course_home" };

	const title =
		doc.querySelector("#section-tabs-header-subtitle") || doc.querySelector(".ic-app-course-menu__header-title");
	ctx.courseName = normalize(title?.textContent);

	const frontPage =
		doc.querySelector('[data-testid="course-homepage-body"]') ||
		doc.querySelector(".show-content") ||
		doc.querySelector("main") ||
		doc.querySelector("article");

	const text = normalize(frontPage?.innerText || frontPage?.textContent || "");
	if (text) {
		ctx.sections.push({
			id: "frontpage",
			heading: "Course home",
			text,
		});
	}

	ctx.rawHtml = frontPage?.innerHTML || null;
	return ctx;
}

// ===== GENERIC FALLBACK =====
function getGenericContext(doc, base) {
	const ctx = { ...base, type: "generic" };

	const h1 = doc.querySelector("h1");
	ctx.title = normalize(h1?.textContent);

	const main =
		doc.querySelector("main") || doc.querySelector('[role="main"]') || doc.querySelector("article") || doc.body;

	const text = normalize(main?.innerText || main?.textContent || "");
	if (text) {
		ctx.sections.push({
			id: "main",
			heading: "Page content",
			text,
		});
	}

	ctx.rawHtml = main?.innerHTML || null;
	return ctx;
}
