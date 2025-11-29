"use strict";

console.log("Canvox: submitAssignment content script loaded");

function normalize(text) {
  return (text || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function findCourseIdByName(courseName) {
  try {
    const name = normalize(courseName);
    if (!name) return null;

    //1) anchors that include /courses/<id>
    const anchors = Array.from(document.querySelectorAll("a[href*='/courses/']"));
    for (const a of anchors) {
      const href = a.getAttribute("href") || "";
      const m = href.match(/\/courses\/(\d+)(?:\/|$)/);
      const text =
        normalize(a.textContent) ||
        normalize(a.getAttribute("title")) ||
        normalize(a.getAttribute("aria-label"));
      if (m && text.includes(name)) return m[1];
    }

    //2) course cards with data-course-id
    const courseEls = Array.from(
      document.querySelectorAll("[data-course-id], [data-courseid], [data-course-id-short]")
    );
    for (const el of courseEls) {
      const id =
        el.dataset.courseId ||
        el.dataset.courseid ||
        el.getAttribute("data-course-id") ||
        el.getAttribute("data-courseid");
      const text =
        normalize(el.textContent) ||
        normalize(el.getAttribute("title")) ||
        normalize(el.getAttribute("aria-label"));
      if (id && text.includes(name)) return id;
    }

    // 3) fallback: anchors + surrounding context
    for (const a of anchors) {
      const href = a.getAttribute("href") || "";
      const m = href.match(/\/courses\/(\d+)(?:\/|$)/);
      if (!m) continue;
      let ctx = normalize(a.textContent);
      const parent = a.closest("li, div, .ic-DashboardCard, .course");
      if (parent) ctx += " " + normalize(parent.textContent);
      if (ctx.includes(name)) return m[1];
    }

    return null;
  } catch (err) {
    console.error("Canvox: findCourseIdByName error", err);
    return null;
  }
}

function clickAssignmentSubmitButton() {
  const selectors = [
    '[data-testid="assignment-submit-button"]',
    '#submit_assignment',
    '.submit_assignment_link',
    'button[type="submit"]'
  ];

  for (const sel of selectors) {
    const btn = document.querySelector(sel);
    if (btn) {
      btn.click();
      console.log("Canvox: assignment submit button clicked via", sel);
      return true;
    }
  }

  console.warn("Canvox: assignment submit button not found");
  return false;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return;

  //1) Handle "submitAssignment" from router.js
  if (message.action === "submitAssignment") {
    try {
      const ok = clickAssignmentSubmitButton();
      sendResponse({ success: ok, error: ok ? null : "button_not_found" });
    } catch (err) {
      console.error("Canvox: submitAssignment handler error", err);
      sendResponse({ success: false, error: "exception" });
    }
    return;
  }

  //2) Existing navigation to course assignments
  if (message.action === "navigateToCourseAssignments" && message.courseName) {
    try {
      const courseId = findCourseIdByName(message.courseName);
      if (!courseId) {
        sendResponse({ success: false, error: "course_not_found" });
        return;
      }

      const url = `${location.origin}/courses/${courseId}/assignments`;
      location.href = url;
      sendResponse({ success: true, url });
    } catch (err) {
      console.error("Canvox: navigateToCourseAssignments handler error", err);
      sendResponse({ success: false, error: "exception" });
    }
  }
});
