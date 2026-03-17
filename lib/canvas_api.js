// lib/canvas_api.js
// Canvas “truth layer” (same-origin; uses user session cookies)

const DEFAULT_PER_PAGE = 50;

function withPerPage(url, perPage = DEFAULT_PER_PAGE) {
  const u = new URL(url, window.location.origin);
  if (!u.searchParams.get("per_page")) u.searchParams.set("per_page", String(perPage));
  return u.toString();
}

function parseNextLink(linkHeader = "") {
  // Canvas uses RFC5988 style Link: <url>; rel="next", <url>; rel="current"
  // We only care about rel="next"
  const parts = String(linkHeader || "").split(",");
  for (const p of parts) {
    const m = p.match(/<([^>]+)>\s*;\s*rel="next"/i);
    if (m?.[1]) return m[1];
  }
  return null;
}

async function fetchJsonPaged(url) {
  let out = [];
  let next = withPerPage(url);

  for (let guard = 0; guard < 25 && next; guard++) {
    const res = await fetch(next, {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Canvas API failed (${res.status}): ${txt.slice(0, 180)}`);
    }

    const data = await res.json();
    if (Array.isArray(data)) out = out.concat(data);
    else if (data && typeof data === "object") out.push(data);

    const link = res.headers.get("Link") || res.headers.get("link") || "";
    next = parseNextLink(link);
  }

  return out;
}

// ---- Public API ------------------------------------------------------------

export async function fetchPlannerItems({ startDateISO, endDateISO } = {}) {
  const u = new URL("/api/v1/planner/items", window.location.origin);
  if (startDateISO) u.searchParams.set("start_date", startDateISO);
  if (endDateISO) u.searchParams.set("end_date", endDateISO);

  // Optional filters you might add later:
  // u.searchParams.set("filter", "due"); // depends on instance support

  return await fetchJsonPaged(u.toString());
}

export async function fetchUserTodo() {
  const u = new URL("/api/v1/users/self/todo", window.location.origin);
  return await fetchJsonPaged(u.toString());
}

// ---- Normalization helpers -------------------------------------------------

export function normalizeCanvasItem(x) {
  // Planner item shape varies. We normalize to a consistent structure.
  const pl = x?.plannable || x?.assignment || x;

  const title =
    x?.plannable?.title ||
    pl?.name ||
    pl?.title ||
    x?.title ||
    "(Untitled)";

  const dueAt =
    pl?.due_at ||
    x?.plannable_date ||
    x?.todo_date ||
    x?.due_at ||
    null;

  const courseId =
    x?.course_id ||
    pl?.course_id ||
    x?.context_id ||
    null;

  const courseName =
    x?.course_name ||
    x?.context_name ||
    pl?.course_name ||
    null;

  const htmlUrl =
    pl?.html_url ||
    x?.html_url ||
    x?.plannable?.html_url ||
    null;

  const points =
    pl?.points_possible ??
    x?.points_possible ??
    null;

  const submitted =
    pl?.has_submitted_submissions ??
    x?.has_submitted_submissions ??
    null;

  const type =
    x?.plannable_type ||
    pl?.submission_types ? "assignment" : (x?.type || "item");

  return {
    title: String(title || "").trim(),
    dueAt: dueAt ? String(dueAt) : null,
    courseId,
    courseName,
    points,
    submitted,
    url: htmlUrl,
    raw: x,
    type,
  };
}
