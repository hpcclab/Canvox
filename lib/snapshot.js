// lib/snapshot.js
// Screen → Snapshot (best-effort DOM extraction)
// This is NOT your “source of truth”; it’s a fallback + extra context.

function safeText(el) {
  return String(el?.textContent || "").replace(/\s+/g, " ").trim();
}

function pageTypeFromUrl(url = "") {
  const u = String(url);
  if (u.includes("/assignments")) return "assignments";
  if (u.includes("/grades")) return "grades";
  if (u.includes("/dashboard")) return "dashboard";
  if (u.includes("/planner")) return "planner";
  if (u.includes("/courses/")) return "course";
  return "unknown";
}

function extractDashboardTodos() {
  // Works on many Canvas instances: “To Do” items on dashboard
  // Try multiple selectors to reduce brittleness
  const items = [];

  const todoBlocks =
    document.querySelectorAll(
      '[data-testid*="todo"], .PlannerItem, .to-do-list li, .todo-list li, .ic-DashboardCard__action-container a'
    ) || [];

  for (const el of Array.from(todoBlocks)) {
    const a = el.closest("a") || el.querySelector?.("a") || (el.tagName === "A" ? el : null);
    const title = safeText(el);
    const url = a?.href || a?.getAttribute?.("href") || null;

    if (!title || title.length < 3) continue;
    items.push({
      title,
      dueAt: null,
      courseName: null,
      url,
      source: "dom:dashboard",
    });
  }

  // Dedupe
  const seen = new Set();
  return items.filter((x) => {
    const k = (x.title + "|" + (x.url || "")).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function extractAssignmentsList() {
  // Canvas assignments list often has assignment name links
  const items = [];
  const links = Array.from(document.querySelectorAll('a[href*="/assignments/"]'));

  for (const a of links) {
    const title = safeText(a);
    if (!title || title.length < 3) continue;

    // try to locate a “Due …” sibling text near the link
    const row = a.closest("tr, li, .ig-row, .assignment, .AssignmentListItem") || a.parentElement;
    const blob = safeText(row);

    let dueAt = null;
    const m = blob.match(/\bDue\b[^A-Za-z0-9]{0,6}(.{0,40})/i);
    if (m?.[1]) dueAt = m[1].trim(); // NOTE: this is human text, not ISO

    items.push({
      title,
      dueAt,
      courseName: null,
      url: a.href,
      rawTextBlob: blob,
      source: "dom:assignments",
    });
  }

  // Dedupe by URL
  const seen = new Set();
  return items.filter((x) => {
    if (!x.url) return true;
    const k = x.url.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function buildSnapshot() {
  const url = window.location.href;
  const type = pageTypeFromUrl(url);

  const title =
    safeText(document.querySelector("h1")) ||
    safeText(document.querySelector("title")) ||
    document.title ||
    "Canvas";

  const snapshot = {
    page: { title, url, type },
    extractedAt: new Date().toISOString(),
    items: [],
  };

  if (type === "dashboard") snapshot.items.push(...extractDashboardTodos());
  if (type === "assignments") snapshot.items.push(...extractAssignmentsList());

  return snapshot;
}
