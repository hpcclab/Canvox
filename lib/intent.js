// intent.js
// Detects and classifies intents (regex + optional ML)

export const intents = {
  OPEN_GRADES: "OPEN_GRADES",
  OPEN_ASSIGNMENTS: "OPEN_ASSIGNMENTS",
  OPEN_COURSES: "OPEN_COURSES",
  READ_PAGE: "READ_PAGE",
  READ_NEXT: "READ_NEXT",
  REPEAT: "REPEAT",
  HELP: "HELP",
  AFFIRM: "AFFIRM",
  DENY: "DENY",
  UNKNOWN: "UNKNOWN"
};

export function normalize(text = "") {
  return text.toLowerCase().replace(/[^\w\s]/gi, "").trim();
}

const RE = {
  grades: /\b(grades?|marks|score)\b/,
  assignments: /\b(assignments?|tasks|homework)\b/,
  courses: /\b(courses?|dashboard)\b/,
  readPage: /\b(read|speak).*(page|content)\b/,
  readNext: /\b(next|continue|more)\b/,
  repeat: /\b(repeat|again)\b/,
  help: /\b(help|commands|what can you do)\b/,
  yes: /\b(yes|sure|okay|ok|yep)\b/,
  no: /\b(no|nah|nope|stop)\b/
};

export async function detectIntent(raw, context = {}) {
  const u = normalize(raw);

  if (RE.grades.test(u)) return { intent: intents.OPEN_GRADES };
  if (RE.assignments.test(u)) return { intent: intents.OPEN_ASSIGNMENTS };
  if (RE.courses.test(u)) return { intent: intents.OPEN_COURSES };
  if (RE.readPage.test(u)) return { intent: intents.READ_PAGE };
  if (RE.readNext.test(u)) return { intent: intents.READ_NEXT };
  if (RE.repeat.test(u)) return { intent: intents.REPEAT };
  if (RE.help.test(u)) return { intent: intents.HELP };
  if (context.expectingYesNo && RE.yes.test(u)) return { intent: intents.AFFIRM };
  if (context.expectingYesNo && RE.no.test(u)) return { intent: intents.DENY };

  return { intent: intents.UNKNOWN };
}
