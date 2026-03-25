// lib/page_text.js
// Robust "what's on the page" text extraction for Canvas.
//
// Why this exists:
// - Canvas pages have lots of UI chrome; grabbing <main>.innerText often returns
//   only headings (like the page title) depending on the layout.
// - Announcements/assignments usually store the real body inside rich-content
//   containers like `.user_content`.
//
// This module finds the *best* visible text block on the page by:
// 1) Checking Canvas-specific rich-content selectors first.
// 2) Falling back to larger layout containers.
// 3) Scoring candidates by length + paragraph count, while rejecting title-only
//    and obviously-noisy UI containers.

"use strict";

function normalizeWs(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function looksLikeUiNoise(t) {
  const s = String(t || "").toLowerCase();
  if (!s) return true;
  // Common Canvas chrome
  return (
    s.includes("collapse threads") ||
    s.includes("oldest first") ||
    s.includes("view split screen") ||
    s.includes("this topic is closed for comments")
  );
}

function cleanCanvasText(raw) {
  let t = String(raw || "");
  // Remove URLs (long + not helpful for summaries)
  t = t.replace(/https?:\/\/\S+/gi, "");
  // Remove common boilerplate
  t = t.replace(/\bLinks to an external site\.?\b/gi, "");
  t = t.replace(/\bThis topic is closed for comments\.?\b/gi, "");
  // Collapse whitespace
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

function scoreCandidate(text) {
  const t = String(text || "");
  if (!t) return 0;
  const len = t.length;
  // Reward paragraph structure (often indicates body content)
  const paras = (t.match(/\n\s*\n/g) || []).length + 1;
  return len + paras * 120;
}

/**
 * Extract the best "main content" text from the current page.
 *
 * @param {Document} doc
 * @returns {{ title: string, text: string }}
 */
export function extractPageMainText(doc = document) {
  const title = normalizeWs(doc.querySelector("h1")?.innerText || doc.title || "");

  // 1) Canvas-rich content blocks (highest priority)
  const primarySelectors = [
    // Announcements
    "[data-testid='announcement-content'] .user_content",
    ".ic-Announcement__content .user_content",
    ".ic-Announcement__content .message.user_content",
    ".message.user_content",
    // Assignments/pages
    "[data-testid='assignment-description']",
    "#assignment_show .user_content",
    ".show-content .user_content",
    ".user_content",
    // General rich content
    "article .user_content",
  ];

  // 2) Layout fallbacks
  const fallbackSelectors = [
    "#content",
    "main",
    "[role='main']",
    "article",
    ".ic-Layout-contentMain",
    "body",
  ];

  const candidates = [];
  const pushNodes = (sels) => {
    for (const sel of sels) {
      try {
        doc.querySelectorAll(sel).forEach((n) => candidates.push(n));
      } catch {
        // ignore
      }
    }
  };

  pushNodes(primarySelectors);
  pushNodes(fallbackSelectors);

  let best = "";
  let bestScore = 0;

  for (const node of candidates) {
    if (!node) continue;

    const raw = node.innerText || node.textContent || "";
    if (!raw) continue;

    const cleaned = cleanCanvasText(raw);
    const normalized = normalizeWs(cleaned);
    if (!normalized) continue;
    if (looksLikeUiNoise(normalized)) continue;

    // Reject title-only blocks.
    if (title && normalized.length <= title.length + 8 && normalized.toLowerCase() === title.toLowerCase()) {
      continue;
    }

    // Prefer substantial blocks.
    const sc = scoreCandidate(cleaned);
    if (sc > bestScore) {
      bestScore = sc;
      best = cleaned;
    }
  }

  // Final cleanup: if we somehow included the title at the start, drop it.
  let text = best;
  if (title && text) {
    const low = normalizeWs(text).toLowerCase();
    const tlow = title.toLowerCase();
    if (low.startsWith(tlow)) {
      text = normalizeWs(text).slice(title.length).trim();
    }
  }

  return { title, text: normalizeWs(text) };
}
