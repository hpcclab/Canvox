#!/usr/bin/env node
// tools/apply-spanish-support.mjs
//
// Applies the Spanish-support additions to lib/actions.js (and appends notes to
// README.md / TEAM_NOTES.md). Run once from the repo root:
//
//     node tools/apply-spanish-support.mjs
//
// Why a script instead of a rewritten actions.js: actions.js is ~3,000 lines and
// only needs a handful of small additions. Retyping the whole file risks silent
// copy mistakes; this script makes ONLY the edits below, checks every anchor
// first, and writes nothing if any anchor is missing or appears an unexpected
// number of times. A backup is saved as lib/actions.js.bak-spanish.
//
// Edits (all additive — no existing logic is removed or rewritten):
//   1. speak(): mark Canvas page content (opts.content) via the language bridge.
//   2. Six reading call sites pass { content: true }.
//   3. New export getInputContext() (free-text wizard steps + names to protect).
//   4. Login overlay: recognizer uses the chosen language; Spanish command words
//      accepted next to the English ones.

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const ACTIONS = path.join(ROOT, "lib", "actions.js");

function fail(msg) {
	console.error(`\n✖ ${msg}\nNo files were changed.`);
	process.exit(1);
}

if (!fs.existsSync(ACTIONS)) fail(`Cannot find ${ACTIONS}. Run this from the repo root.`);

let src = fs.readFileSync(ACTIONS, "utf8");
const eol = src.includes("\r\n") ? "\r\n" : "\n";
if (eol === "\r\n") src = src.replace(/\r\n/g, "\n");

if (src.includes("export async function getInputContext(")) {
	console.log("✔ lib/actions.js already has the Spanish-support edits. Nothing to do.");
	process.exit(0);
}

// --- helpers -----------------------------------------------------------------
const edits = [];

function countOf(haystack, needle) {
	if (needle instanceof RegExp) {
		const re = new RegExp(needle.source, needle.flags.includes("g") ? needle.flags : needle.flags + "g");
		return (haystack.match(re) || []).length;
	}
	return haystack.split(needle).length - 1;
}

// Register an edit; verify the anchor occurs exactly `expected` times.
function edit(name, anchor, replacement, expected = 1) {
	const n = countOf(src, anchor);
	if (n !== expected) {
		fail(`Edit "${name}": expected ${expected} match(es) for anchor, found ${n}.\nAnchor: ${anchor}`);
	}
	edits.push({ name, anchor, replacement });
}

function applyAll() {
	for (const { anchor, replacement } of edits) {
		if (anchor instanceof RegExp) {
			const re = new RegExp(anchor.source, anchor.flags.includes("g") ? anchor.flags : anchor.flags + "g");
			src = src.replace(re, replacement);
		} else {
			src = src.split(anchor).join(typeof replacement === "function" ? replacement(anchor) : replacement);
		}
	}
}

// --- 1) speak(): mark page content -------------------------------------------
edit(
	"speak() content marking",
	/^([ \t]*)utter\.lang = opts\.lang \?\? "en-US";$/m,
	(line, indent) =>
		`${line}\n` +
		`${indent}// Spanish support: Canvas page content (opts.content) can be read in its original\n` +
		`${indent}// language; see lib/translate.js. No-op when the language layer isn't loaded.\n` +
		`${indent}if (opts.content) globalThis.__CONVOX?.lang?.markContent?.(utter);`,
);

// --- 2) reading call sites: { content: true } --------------------------------
edit(
	"announcement body",
	'await speak(chunk, { raw: true, mode: "read" });',
	'await speak(chunk, { raw: true, mode: "read", content: true });',
);
edit(
	"recent message body",
	"await speak(`Message: ${detail.bodyPreview}`, { raw: true, mode: \"read\" });",
	"await speak(`Message: ${detail.bodyPreview}`, { raw: true, mode: \"read\", content: true });",
);
edit(
	"page/section reading (actReadPage x2, actReadNext, actRepeat)",
	/speak\(makeSpokenSection\((chunk|out)\), \{ mode: "read" \}\)/g,
	'speak(makeSpokenSection($1), { mode: "read", content: true })',
	4,
);

// --- 3) getInputContext() ------------------------------------------------------
const HANDLE_ANCHOR = "export async function handleUtterance(utterance, nluDetect) {";
edit(
	"getInputContext export",
	HANDLE_ANCHOR,
	`// =============================================================================
// Spanish support: input context for the translation layer (content_test.js)
// =============================================================================
// freeText: a wizard step is collecting the user's own words (message
//           recipient/subject/body, discussion title/content). Those must be
//           written exactly as spoken, never translated.
// labels:   names currently offered to the user (choice options, compose course
//           options, a course awaiting confirmation) so the translator keeps
//           them unchanged.
export async function getInputContext() {
	let st = null;
	try {
		st = await mem.get();
	} catch {
		return { freeText: false, labels: [] };
	}
	const cw = st?.composeWizard;
	const dw = st?.discussionWizard;
	const freeText =
		(cw?.active && ["recipient", "subject", "body"].includes(cw.step)) ||
		(dw?.active && ["title", "content"].includes(dw.step));
	const labels = [
		...(Array.isArray(st?.choiceOptions) ? st.choiceOptions.map((o) => o?.label) : []),
		...(cw?.active && cw.step === "course" && Array.isArray(cw.courseOptions)
			? cw.courseOptions.map((o) => o?.label)
			: []),
		st?.pendingLabel,
	].filter(Boolean);
	return { freeText: !!freeText, labels };
}

${HANDLE_ANCHOR}`,
);

// --- 4) login overlay voice input ---------------------------------------------
edit(
	"overlay recognizer language",
	'overlayRec.lang = "en-US";',
	'overlayRec.lang = globalThis.__CONVOX?.lang?.speechLocale?.() || "en-US";',
);
edit(
	"overlay username pattern",
	"const unMatch = t.match(/\\b(?:set\\s+)?(?:username|user|euid)\\s+(?:is\\s+)?(\\S+)/);",
	"const unMatch = t.match(\n" +
		"\t\t\t\t/\\b(?:(?:set|pon|poner|establece|establecer|configura)\\s+(?:el\\s+|mi\\s+)?)?(?:username|user|euid|usuario)\\s+(?:is\\s+|es\\s+)?(\\S+)/,\n" +
		"\t\t\t);",
);
edit(
	"overlay password pattern",
	"const pwMatch = t.match(/\\b(?:set\\s+)?password\\s+(?:is\\s+)?(\\S+)/);",
	"const pwMatch = t.match(\n" +
		"\t\t\t\t/(?:\\b(?:set|pon|poner|establece|establecer|configura)\\s+(?:la\\s+|mi\\s+)?)?\\b(?:password|contraseña|contrasena|clave)\\s+(?:is\\s+|es\\s+)?(\\S+)/,\n" +
		"\t\t\t);",
);
edit(
	"overlay save words",
	"/\\b(save|done|confirm)\\b/.test(t)",
	"/\\b(save|done|confirm|guardar|guarda|listo|confirmar)\\b/.test(t)",
);
edit(
	"overlay cancel words",
	"/\\b(cancel|close|exit)\\b/.test(t)",
	"/\\b(cancel|close|exit|cancelar|cerrar|salir)\\b/.test(t)",
);

// --- write ---------------------------------------------------------------------
applyAll();

// Sanity checks after applying
if (countOf(src, "content: true") !== 6) fail("Post-check: expected 6 { content: true } call sites.");
if (!src.includes("export async function getInputContext(")) fail("Post-check: getInputContext missing.");

fs.copyFileSync(ACTIONS, ACTIONS + ".bak-spanish");
fs.writeFileSync(ACTIONS, eol === "\r\n" ? src.replace(/\n/g, "\r\n") : src, "utf8");
console.log("✔ lib/actions.js updated (" + edits.length + " edits). Backup: lib/actions.js.bak-spanish");
for (const e of edits) console.log("   • " + e.name);

// --- docs ----------------------------------------------------------------------
const MARK = "<!-- canvox-spanish-support -->";

const README_SECTION = `
${MARK}
## Spanish support (Español)

Convox can be used in Spanish. Switch with the **🌐 Español** button in the Convox
panel, or in **chrome://extensions → Convox → Details → Extension options → Language**.

How it works:

- Spanish commands are converted to English by an offline layer
  (\`lib/translate.js\`) and then run through the **unchanged** English pipeline
  (\`lib/actions.js\` → \`lib/intent.js\`).
- Common commands are matched by a built-in Spanish phrase list; everything else
  uses **Chrome's built-in on-device Translator API**. No cloud translation, no
  API keys, no third-party services.
- Convox's spoken replies are translated to Spanish on-device. Canvas page content
  (announcements, messages, page reading) is read in its original language unless
  "Read Canvas page content in Spanish" is turned on.
- Interface text comes from \`_locales/en\` and \`_locales/es\` (\`chrome.i18n\` format).

Requirements and limits:

- Desktop Chrome with the built-in Translator API (Chrome 138+). The Spanish
  language pack downloads **once** (press the language button while online);
  after that translation works offline.
- **Voice input:** Chrome's speech recognition uses Google's online service unless
  on-device recognition is available on that computer (newer Chrome; Convox uses
  it automatically in Spanish mode when installed). Typed commands always work offline.
- Keep **Canvas's own language set to English**. Some features (compose, announcements,
  due-date detection on the page) look for English words in Canvas's interface.
- Run the tests with \`npm test\`.
`;

const NOTES_SECTION = `
${MARK}
## Spanish support — team notes

- \`lib/intent.js\` is intentionally unchanged. To support a new Spanish phrasing,
  add a line to \`PHRASEBOOK\` / \`GLOSSARY_ES\` / \`FIXUPS\` in \`lib/translate.js\`
  and a test in \`tests/translate.test.js\` — never duplicate intent rules.
- Do not pass a second argument to \`handleUtterance()\`: it is the intent detector.
- Import \`lib/i18n.js\` / \`lib/translate.js\` **without** a \`?v=\` query string, or
  you get a second copy of the module with its own language state.
- Language setting: \`chrome.storage.sync\` key \`canvoxLang\` ("en" | "es").
  Page-content setting: \`canvoxTranslateContent\` (boolean).
- Round-trip check after editing any English prompt that tells the user what to
  say ("Say: …"): speak its Spanish translation and confirm the debug line
  "→ EN (…)" produces a working command.

Known issues found during the Spanish work (not changed):

- \`src/\` and \`content.js\` are the old path; \`src/model/tts.js\` and
  \`src/model/navigation.js\` send page text to a Heroku server. They are not loaded
  by the manifest — keep it that way (offline / no third-party requirement).
- \`src/view/popup.html\` is not wired (no \`"action"\` in the manifest), references a
  missing \`../scripts/defaults.js\`, and loads its logo from imgur.
- \`actions.js\` calls \`llmAnswerQuestion\` / \`llmRewriteForSpeech\` without importing
  them, so due-date answers always use the plain fallback text (which works).
  Don't re-add the import: \`tiny_llm.js\` needs a local Ollama server.
- The login overlay's \`saveAndClose\` uses \`findFirst\` / \`USERNAME_SELECTORS\`,
  which only exist inside \`actLogIn\`, so saving from the overlay throws.
- Credentials are stored in plain text in \`chrome.storage.local\`, and voice-entered
  passwords are lower-cased by \`options.js\` / the overlay.
- Unused files: \`lib/convox_actions.js\`, \`lib/models.js\`, \`lib/memory.js\`,
  \`lib/nlp.js\`, \`lib/tiny_llm.js\`, \`lib/planner.js\`, and the \`@mlc-ai/web-llm\`
  dependency.
`;

function appendOnce(file, section) {
	const p = path.join(ROOT, file);
	const cur = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
	if (cur.includes(MARK)) {
		console.log(`✔ ${file} already has the Spanish section.`);
		return;
	}
	fs.writeFileSync(p, cur.replace(/\s*$/, "\n") + section, "utf8");
	console.log(`✔ ${file} updated.`);
}

appendOnce("README.md", README_SECTION);
appendOnce("TEAM_NOTES.md", NOTES_SECTION);

console.log("\nDone. Reload the extension in chrome://extensions, then run: npm test");
