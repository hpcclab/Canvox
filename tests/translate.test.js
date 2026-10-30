// tests/translate.test.js
// Run with: npm test   (Node 18+; uses only node:test, no dependencies)
//
// Checks that Spanish commands become English text that the UNCHANGED
// lib/intent.js already understands, and that English passes through untouched.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// ---- Minimal browser/extension shims (must exist before the modules run) -----
globalThis.self = globalThis;
globalThis.chrome = {
	runtime: { getURL: (p) => p },
	i18n: { getMessage: () => "", getUILanguage: () => "en" },
	storage: {
		sync: { get: async () => ({}), set: async () => {} },
		onChanged: { addListener: () => {} },
	},
};

const tr = await import("../lib/translate.js");
const { detectIntent, intents } = await import("../lib/intent.js");

// One fake on-device translator for the whole file (translate.js caches the
// translator it creates). Each test sets the phrases it should "translate",
// literally, the way a real translator would (e.g. "notas" -> "notes").
let fakeDictionary = [];
function installFakeTranslator(dictionary) {
	fakeDictionary = dictionary;
	globalThis.Translator ??= {
		availability: async () => "available",
		create: async () => ({
			translate: async (text) => {
				let out = text;
				for (const [es, en] of fakeDictionary) out = out.replace(es, en);
				return out;
			},
		}),
	};
}

// ---- English is untouched ----------------------------------------------------
test("English input passes through unchanged", async () => {
	for (const s of ["open my grades", "Open course 4901 and then open grades", "what's due today?"]) {
		const r = await tr.toEnglish(s, { lang: "en" });
		assert.equal(r.text, s);
		assert.equal(r.source, "passthrough");
	}
});

// ---- Phrasebook: Spanish -> English -> existing intent ------------------------
const CASES = [
	// [spanish, expected English, expected intent, detectIntent context]
	["¿Qué vence hoy?", "due today", intents.DUE_TODAY],
	["¿Qué tengo pendiente esta semana?", "due this week", intents.DUE_THIS_WEEK],
	["próxima entrega", "next due", intents.NEXT_DUE],
	["tareas atrasadas", "overdue", intents.OVERDUE],
	["Muéstrame mis notas", "open my grades", intents.OPEN_GRADES],
	["abre mis calificaciones", "open my grades", intents.OPEN_GRADES],
	["abre mis tareas", "open my assignments", intents.OPEN_ASSIGNMENTS],
	["abre los módulos", "open my modules", intents.OPEN_MODULES],
	["abre los cuestionarios", "open my quizzes", intents.OPEN_QUIZZES],
	["abre los archivos", "open my files", intents.OPEN_FILES],
	["abre mis cursos", "open my courses", intents.OPEN_COURSES],
	["abre la bandeja de entrada", "open my inbox", intents.OPEN_INBOX],
	["abre el panel", "open my dashboard", intents.OPEN_DASHBOARD],
	["ir al inicio", "open my home", intents.OPEN_HOME],
	// Same English as the panel hint "open course 4901". actions.js routes it through its
	// course-query step before intent.js, exactly like the English command (null = skip intent check).
	["abre el curso 4901", "open course 4901", null],
	["lee la página", "read the page", intents.READ_PAGE],
	["resume esta página", "summarize page", intents.SUMMARIZE_PAGE],
	["siguiente", "next section", intents.READ_NEXT],
	["repite", "repeat", intents.REPEAT],
	["ayuda", "help", intents.HELP],
	["atrás", "go back", intents.GO_BACK],
	["redactar mensaje", "compose message", intents.COMPOSE_MESSAGE],
	["iniciar sesión", "log in", intents.LOG_IN],
	["sí", "yes", intents.AFFIRM, { expectingYesNo: true }],
	["no", "no", intents.DENY, { expectingYesNo: true }],
	["cancelar", "cancel", intents.DENY, { expectingYesNo: true }],
	["opción 3", "option 3", intents.CHOOSE_OPTION, { expectingChoice: true }],
	["la segunda", "option second", intents.CHOOSE_OPTION, { expectingChoice: true }],
];

for (const [es, en, intent, ctx] of CASES) {
	test(`phrasebook: "${es}" -> "${en}" -> ${intent}`, async () => {
		const r = await tr.toEnglish(es, { lang: "es" });
		assert.equal(r.source, "phrasebook");
		assert.equal(r.text, en);
		if (intent) {
			const det = await detectIntent(r.text, ctx || {});
			assert.equal(det.intent, intent);
		}
	});
}

test("phrasebook works with no translator installed (offline fallback)", async () => {
	assert.equal(typeof globalThis.Translator, "undefined");
	const r = await tr.toEnglish("abre la tarea 2", { lang: "es" });
	assert.equal(r.text, "open homework 2");
});

test("unknown Spanish with no translator is reported as untranslated", async () => {
	assert.equal(typeof globalThis.Translator, "undefined");
	const r = await tr.toEnglish("¿me puedes contar un chiste?", { lang: "es" });
	assert.equal(r.source, "untranslated");
});

// ---- Translator path: glossary masking + fixups -------------------------------
test("glossary keeps Canvas words: 'notas' becomes 'grades', not 'notes'", async () => {
	installFakeTranslator([
		[/^Por favor abre mis (\[\d+\]) ahora/, "Please open my $1 now"],
		[/notas/, "notes"],
	]);
	const r = await tr.toEnglish("Por favor abre mis notas ahora", { lang: "es" });
	assert.equal(r.source, "translator");
	assert.match(r.text, /open my grades/i);
	assert.equal((await detectIntent(r.text)).intent, intents.OPEN_GRADES);
});

test("'expires today' is rewritten to the 'due' wording intent.js expects", async () => {
	installFakeTranslator([[/^¿Qué entregas vencen hoy para mí\?$/, "What deliveries expire today for me?"]]);
	const r = await tr.toEnglish("¿Qué entregas vencen hoy para mí?", { lang: "es" });
	assert.equal((await detectIntent(r.text)).intent, intents.DUE_TODAY);
});

test("chained command: 'and then the grades' gets a verb", async () => {
	installFakeTranslator([[/^Abre el curso 4901 y luego las (\[\d+\])$/, "Open the course 4901 and then the $1"]]);
	const r = await tr.toEnglish("Abre el curso 4901 y luego las calificaciones", { lang: "es" });
	assert.equal(r.text, "Open course 4901 and then open grades");
});

test("missing 'for' between a section and a course number is restored", async () => {
	installFakeTranslator([[/^abre mis (\[\d+\]) de matemáticas 2700$/, "Open My $1 Math 2700"]]);
	const r = await tr.toEnglish("abre mis calificaciones de matemáticas 2700", { lang: "es" });
	assert.equal(r.text, "Open My grades for Math 2700");
	// homework numbers are not course numbers: no "for" added
	installFakeTranslator([[/^abre la (\[\d+\]) 2$/, "open the $1 2"]]);
	const r2 = await tr.toEnglish("abre la tarea 2", { lang: "es" });
	assert.equal(r2.text, "open homework 2");
});

test("protected names are not translated", async () => {
	installFakeTranslator([
		[/^Quiero el de (\[\d+\]) por favor$/, "I want the one from $1 please"],
		[/Historia/, "History"],
	]);
	const terms = tr.termsFromLabels(["HIST 1050 Historia del Arte"]);
	assert.ok(terms.includes("Historia"));
	const r = await tr.toEnglish("Quiero el de Historia por favor", { lang: "es", protectTerms: terms });
	assert.match(r.text, /Historia/);
	assert.doesNotMatch(r.text, /History/);
});

test("replies: 'Opening …' is sent to the translator as 'I'm opening …'", async () => {
	assert.equal(
		tr.prepareReplyForTranslation("Opening announcement. GEOL 1610."),
		"I'm opening announcement. GEOL 1610.",
	);
	assert.equal(tr.prepareReplyForTranslation("Okay. Opening grades."), "Okay. I'm opening grades.");
	assert.equal(tr.prepareReplyForTranslation("Say option 1."), "Say option 1.");
	installFakeTranslator([[/^I'm opening announcement\. (.*)$/, "Estoy abriendo el anuncio. $1"]]);
	assert.equal(
		await tr.fromEnglish("Opening announcement. GEOL 1610.", { lang: "es" }),
		"Estoy abriendo el anuncio. GEOL 1610.",
	);
});

// ---- Helpers -----------------------------------------------------------------
test("isCancelPhrase matches whole-utterance cancel words only", () => {
	assert.equal(tr.isCancelPhrase("Cancelar."), true);
	assert.equal(tr.isCancelPhrase("olvídalo"), true);
	assert.equal(tr.isCancelPhrase("para el lunes cancelar la reunión"), false);
});

// ---- Locale files --------------------------------------------------------------
test("en and es locale files have the same keys and placeholders", () => {
	const en = JSON.parse(fs.readFileSync(new URL("../_locales/en/messages.json", import.meta.url), "utf8"));
	const es = JSON.parse(fs.readFileSync(new URL("../_locales/es/messages.json", import.meta.url), "utf8"));
	assert.deepEqual(Object.keys(es).sort(), Object.keys(en).sort());
	for (const k of Object.keys(en)) {
		assert.deepEqual(Object.keys(es[k].placeholders || {}).sort(), Object.keys(en[k].placeholders || {}).sort(), k);
	}
});
