// lib/translate.js  (v2)
// Spanish <-> English normalization layer for Canvox.
//
// - Uses ONLY Chrome's built-in, on-device Translator API. No network calls of
//   our own, no API keys, no third-party services.
// - intent.js and the English parsers in actions.js are never modified: Spanish
//   input is converted to English phrasing they already accept.
// - English mode is a strict pass-through.
//
// Input pipeline (Spanish):
//   1. Phrasebook: exact Spanish commands -> exact English commands (no model needed)
//   2. Mask: quoted text + protected names (kept as-is) + Canvas glossary terms
//      (replaced by the English Canvas word after translation)
//   3. Translator API (on-device)
//   4. Fixups: rewrite common translator phrasing into the wording intent.js expects
//
// One-time setup: Chrome downloads the es<->en pack the first time, and
// Translator.create() needs a user gesture when a download is required.
// Call prepareSpanish() from inside a click/keydown handler.
//
// Import WITHOUT a ?v= query string (see note in i18n.js).

import { getLang, speechLocale } from "./i18n.js";

// ---------------------------------------------------------------------------
// Translator management
// ---------------------------------------------------------------------------
const translators = new Map(); // "es>en" -> Translator
const pending = new Map(); // "es>en" -> Promise<Translator|null>

export function hasTranslatorAPI() {
	return typeof self.Translator?.create === "function";
}

// "unsupported" | "unavailable" | "downloadable" | "downloading" | "available"
export async function languagePackStatus(src, tgt) {
	if (!hasTranslatorAPI()) return "unsupported";
	try {
		return await self.Translator.availability({ sourceLanguage: src, targetLanguage: tgt });
	} catch {
		return "unavailable";
	}
}

async function getTranslator(src, tgt, { allowDownload = false, onProgress } = {}) {
	const key = `${src}>${tgt}`;
	if (translators.has(key)) return translators.get(key);
	if (pending.has(key)) return pending.get(key);

	const p = (async () => {
		const status = await languagePackStatus(src, tgt);
		if (status === "unsupported" || status === "unavailable") return null;
		if (status !== "available" && !(allowDownload && navigator.userActivation?.isActive)) return null;
		try {
			const tr = await self.Translator.create({
				sourceLanguage: src,
				targetLanguage: tgt,
				monitor(m) {
					m.addEventListener("downloadprogress", (e) => onProgress?.(e.loaded));
				},
			});
			translators.set(key, tr);
			return tr;
		} catch (e) {
			console.warn("[Canvox translate] Translator.create failed:", key, e);
			return null;
		}
	})();

	pending.set(key, p);
	try {
		return await p;
	} finally {
		pending.delete(key);
	}
}

// Call synchronously at the start of a click/keydown handler (before any await).
export async function prepareLanguage(lang = "es", opts = {}) {
	if (lang === "en") return { input: true, output: true };
	const [toEn, fromEn] = await Promise.all([
		getTranslator(lang, "en", { allowDownload: true, ...opts }),
		getTranslator("en", lang, { allowDownload: true, ...opts }),
	]);
	return { input: !!toEn, output: !!fromEn };
}

export const prepareSpanish = (opts) => prepareLanguage("es", opts);

// ---------------------------------------------------------------------------
// Shared text helpers
// ---------------------------------------------------------------------------
function stripAccents(s) {
	return String(s || "")
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "");
}

function simplify(s) {
	return stripAccents(s)
		.toLowerCase()
		.replace(/[¿?¡!.,;:"“”«»]/g, " ")
		.replace(/\bpor favor\b/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function escapeRe(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Whole-word match that also works for accented letters (JS \b does not).
function wordRe(term) {
	return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(term)}(?![\\p{L}\\p{N}])`, "giu");
}

// ---------------------------------------------------------------------------
// 1) Phrasebook: whole-utterance Spanish commands -> English that the existing
//    rules in intent.js / actions.js already match. Works with no model at all,
//    so it is also the offline fallback before the language pack is downloaded.
// ---------------------------------------------------------------------------
const ORDINALS_ES = {
	primero: "first",
	primera: "first",
	primer: "first",
	segundo: "second",
	segunda: "second",
	tercero: "third",
	tercera: "third",
	tercer: "third",
	cuarto: "fourth",
	cuarta: "fourth",
	quinto: "fifth",
	quinta: "fifth",
	sexto: "sixth",
	sexta: "sixth",
	septimo: "seventh",
	septima: "seventh",
	octavo: "eighth",
	octava: "eighth",
};

// Spanish section word -> English section word used by the existing rules.
const SECTIONS_ES = {
	"bandeja de entrada": "inbox",
	"panel de control": "dashboard",
	tareas: "assignments",
	deberes: "assignments",
	calificaciones: "grades",
	notas: "grades",
	modulos: "modules",
	cuestionarios: "quizzes",
	examenes: "quizzes",
	archivos: "files",
	cursos: "courses",
	anuncios: "announcements",
	mensajes: "inbox",
	buzon: "inbox",
	panel: "dashboard",
	tablero: "dashboard",
	inicio: "home",
};
const SECTION_ALT = Object.keys(SECTIONS_ES)
	.sort((a, b) => b.length - a.length)
	.map(escapeRe)
	.join("|");
const OPEN_ES = "(?:abre|abrir|abra|abreme|muestra|muestrame|mostrar|ver|(?:ir|ve|vamos|llevame) al?)";
const DET_ES = "(?:mis|mi|las|los|la|el|al)";
const DUE_VERB_ES = "(?:vence|vencen|hay|tengo|se entrega|entrego|tengo que entregar|tengo pendiente)";

const PHRASEBOOK = [
	[/^(?:si|claro|vale|de acuerdo|hazlo|correcto)$/, "yes"],
	[/^(?:no|nop|nel)$/, "no"],
	[/^(?:cancela|cancelar|cancelalo|olvidalo|no importa|descarta|descartar|deten|detente)$/, "cancel"],
	[/^(?:atras|regresa|regresar|volver|vuelve|vuelve atras|ir atras|pagina anterior)$/, "go back"],
	[/^(?:ayuda|que puedes hacer|comandos)$/, "help"],
	[/^(?:repite|repitelo|repetir|otra vez|de nuevo)$/, "repeat"],
	[/^(?:siguiente|continua|continuar|sigue|siguiente seccion)$/, "next section"],
	[/^(?:lee|leer|lea|leeme)(?: (?:esta|la))? pagina$/, "read the page"],
	[/^(?:resume|resumir|resumeme|resumen)(?: (?:de )?(?:esta|la) pagina)?$/, "summarize page"],
	[new RegExp(`^(?:que\\s+)?${DUE_VERB_ES}(?:\\s+para)?\\s+hoy$`), "due today"],
	[new RegExp(`^(?:que\\s+)?${DUE_VERB_ES}(?:\\s+para)?\\s+esta semana$`), "due this week"],
	[/^(?:cual es la\s+)?(?:proxima|siguiente) (?:entrega|fecha de entrega|tarea)$/, "next due"],
	[/^(?:que\s+)?(?:tengo\s+)?(?:algo\s+)?(?:tareas\s+)?(?:atrasad[oa]s?|vencid[oa]s?)$/, "overdue"],
	[new RegExp(`^${OPEN_ES}\\s+(?:${DET_ES}\\s+)?(${SECTION_ALT})$`), (m) => `open my ${SECTIONS_ES[m[1]]}`],
	[/^(?:abre|abrir|abra|(?:ir|ve) al?)\s+(?:el\s+)?curso\s+([a-z]{0,5}\s*\d{3,4})$/, (m) => `open course ${m[1].trim()}`],
	[/^(?:abre|abrir|abra)\s+(?:la\s+)?(?:tarea|deber)\s+(\d+)$/, (m) => `open homework ${m[1]}`],
	[/^(?:(?:la\s+)?opcion|el numero|numero)\s+(\d{1,2})$/, (m) => `option ${m[1]}`],
	[
		new RegExp(`^(?:la\\s+|el\\s+)?(?:opcion\\s+)?(${Object.keys(ORDINALS_ES).join("|")})(?:\\s+opcion)?$`),
		(m) => `option ${ORDINALS_ES[m[1]]}`,
	],
	[/^(?:redacta|redactar|escribe|escribir|crea|crear|nuevo)\s+(?:un\s+)?(?:nuevo\s+)?mensaje$/, "compose message"],
	[/^(?:envia|enviar|envialo|enviarlo|manda|mandalo)$/, "send"],
	[/^(?:inicia sesion|iniciar sesion|entrar|acceder)$/, "log in"],
];

export function phrasebookToEnglish(text) {
	const s = simplify(text);
	if (!s) return null;
	for (const [re, out] of PHRASEBOOK) {
		const m = s.match(re);
		if (m) return typeof out === "function" ? out(m) : out;
	}
	return null;
}
export const fallbackToEnglish = phrasebookToEnglish; // name used by earlier tests

// Whole-utterance cancel words, used while a wizard is collecting free text.
export function isCancelPhrase(text) {
	return /^(?:cancela|cancelar|cancelalo|olvidalo|no importa|descarta|descartar|deten|detente)$/.test(simplify(text));
}

// ---------------------------------------------------------------------------
// 2) Masking: protected names stay untouched; glossary terms become the exact
//    English Canvas word after translation (e.g. "notas" -> "grades", not "notes").
// ---------------------------------------------------------------------------
const GLOSSARY_ES = [
	["bandeja de entrada", "inbox"],
	["panel de control", "dashboard"],
	["calificaciones", "grades"],
	["calificación", "grade"],
	["calificacion", "grade"],
	["notas", "grades"],
	["tareas", "homework"],
	["tarea", "homework"],
	["deberes", "homework"],
	["módulos", "modules"],
	["modulos", "modules"],
	["módulo", "module"],
	["modulo", "module"],
	["cuestionarios", "quizzes"],
	["cuestionario", "quiz"],
	["exámenes", "quizzes"],
	["examenes", "quizzes"],
	["archivos", "files"],
	["anuncios", "announcements"],
	["anuncio", "announcement"],
	["tablero", "dashboard"],
	["inicio", "home"],
	["buzón", "inbox"],
	["buzon", "inbox"],
	["discusiones", "discussions"],
	["discusión", "discussion"],
	["discusion", "discussion"],
	["foro", "discussion"],
	["resúmeme", "summarize"],
	["resumeme", "summarize"],
	["resumir", "summarize"],
	["resume", "summarize"],
];

const QUOTE_RE = /"[^"]+"|“[^”]+”|«[^»]+»/g;

const LABEL_STOP = new Set(["with", "from", "section", "course", "courses", "fall", "spring", "summer", "winter", "favorite", "groups", "and", "the", "for"]);

// Turn course/assignment/option labels into distinctive words worth protecting.
export function termsFromLabels(labels = []) {
	const out = new Set();
	for (const l of labels) {
		for (const w of String(l || "").split(/[^\p{L}\p{N}]+/u)) {
			if (w.length >= 4 && /\p{L}/u.test(w) && !LABEL_STOP.has(w.toLowerCase())) out.add(w);
		}
	}
	return [...out];
}

function mask(text, protectTerms = []) {
	const slots = [];
	const put = (restoreAs) => {
		slots.push(restoreAs);
		return `[${slots.length - 1}]`;
	};

	let masked = text.replace(QUOTE_RE, (m) => put(m));

	const terms = [...new Set(protectTerms.filter(Boolean).map(String))].sort((a, b) => b.length - a.length);
	for (const term of terms) masked = masked.replace(wordRe(term), (m) => put(m));

	for (const [es, en] of GLOSSARY_ES) masked = masked.replace(wordRe(es), () => put(en));

	return { masked, slots };
}

// Returns null if the translator dropped or mangled a placeholder.
function restore(text, slots) {
	let used = 0;
	const out = String(text).replace(/\[\s*(\d+)\s*\]/g, (m, i) => {
		const v = slots[Number(i)];
		if (v == null) return m;
		used++;
		return v;
	});
	return used === slots.length ? out : null;
}

// ---------------------------------------------------------------------------
// 3) Post-translation fixups: translator wording -> wording the rules expect.
// ---------------------------------------------------------------------------
const SECTION_EN =
	"(?:course|courses|grades|grade|homework|assignments|modules|quizzes|files|inbox|dashboard|announcements|home)";

const FIXUPS = [
	// "open the grades" -> "open grades" (strong rules expect open [my] <section>)
	[new RegExp(`\\b(open|go to|show me|take me to)\\s+the\\s+(?=${SECTION_EN}\\b)`, "gi"), "$1 "],
	// "show my grades" -> "show me my grades" ("show me" is an open-synonym, "show" alone is not)
	[/^show\s+(?!me\b)/i, "show me "],
	// "and then the grades" -> "and then open grades" (gives chained steps a verb)
	[new RegExp(`\\b(and then|then|after that)\\s+(?:the\\s+)?(?=${SECTION_EN}\\b)`, "gi"), "$1 open "],
	[/\bnext (?:delivery|submission|deadline|due date)\b/gi, "next due"],
];

function dueFixup(s) {
	if (!/\b(today|tonight|this week)\b/i.test(s)) return s;
	return s.replace(
		/\b(?:expires?|expiring|is due|are due|has to be (?:turned in|delivered|submitted)|(?:have|need) to (?:turn in|hand in|deliver|submit)|pending|to deliver|to submit|deliver(?:y|ies)?)\b/gi,
		"due",
	);
}

function ordinalFixup(s) {
	const m = s
		.trim()
		.match(/^(?:the\s+)?(?:option\s+)?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)(?:\s+(?:one|option))?$/i);
	return m ? `option ${m[1].toLowerCase()}` : s;
}

function tidy(s) {
	return String(s)
		.replace(/^[\s¿¡]+/, "")
		.replace(/[\s.!?]+$/, "")
		.replace(/\s+/g, " ");
}

function postFix(s) {
	let out = tidy(s);
	for (const [re, rep] of FIXUPS) out = out.replace(re, rep);
	out = dueFixup(out);
	out = ordinalFixup(out);
	return out.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Input API
// Result: { text, original, lang, source }
// source: "passthrough" | "phrasebook" | "translator" | "untranslated"
// ---------------------------------------------------------------------------
export async function toEnglish(text, { lang = getLang(), protectTerms = [] } = {}) {
	const original = String(text ?? "");
	if (lang === "en" || !original.trim()) {
		return { text: original, original, lang, source: "passthrough" };
	}

	const pb = phrasebookToEnglish(original);
	if (pb) return { text: pb, original, lang, source: "phrasebook" };

	const tr = await getTranslator(lang, "en");
	if (tr) {
		try {
			const { masked, slots } = mask(original, protectTerms);
			let out = slots.length ? restore(await tr.translate(masked), slots) : await tr.translate(original);
			if (out == null) out = await tr.translate(original); // placeholder lost: plain translation
			return { text: postFix(out), original, lang, source: "translator" };
		} catch (e) {
			console.warn("[Canvox translate] toEnglish failed:", e);
		}
	}

	return { text: original, original, lang, source: "untranslated" };
}

// ---------------------------------------------------------------------------
// Output: English -> user language
// ---------------------------------------------------------------------------
const outCache = new Map();
const OUT_CACHE_MAX = 200;

async function translateChunked(tr, text, max = 900) {
	if (text.length <= max) return tr.translate(text);
	const sentences = text.match(/[^.!?\n]+[.!?\n]*\s*/g) || [text];
	const chunks = [];
	let buf = "";
	for (const s of sentences) {
		if (buf && buf.length + s.length > max) {
			chunks.push(buf);
			buf = "";
		}
		buf += s;
	}
	if (buf) chunks.push(buf);
	const out = [];
	for (const c of chunks) out.push(await tr.translate(c));
	return out.join(" ");
}

// Returns translated text, or null if translation isn't possible (caller keeps English).
export async function fromEnglish(text, { lang = getLang() } = {}) {
	const s = String(text ?? "");
	if (lang === "en" || !s.trim()) return s;
	const key = `${lang}:${s}`;
	if (outCache.has(key)) return outCache.get(key);
	const tr = await getTranslator("en", lang);
	if (!tr) return null;
	try {
		const out = await translateChunked(tr, s);
		if (outCache.size >= OUT_CACHE_MAX) outCache.delete(outCache.keys().next().value);
		outCache.set(key, out);
		return out;
	} catch (e) {
		console.warn("[Canvox translate] fromEnglish failed:", e);
		return null;
	}
}

// ---------------------------------------------------------------------------
// Speech output hook
// ---------------------------------------------------------------------------
// LOCALIZED: already in the user's language (built from t()); don't translate, use Spanish voice.
// CONTENT:   Canvas page content (announcement/message bodies, page reading).
//            Spoken in the original language unless "translate page content" is on.
const LOCALIZED = new WeakSet();
const CONTENT = new WeakSet();
const TRANSLATE_CONTENT_KEY = "canvoxTranslateContent";
let translateContent = false;

export function markLocalized(utter) {
	if (utter) LOCALIZED.add(utter);
	return utter;
}
export function markContent(utter) {
	if (utter) CONTENT.add(utter);
	return utter;
}
export async function getTranslateContent() {
	try {
		const v = await chrome.storage.sync.get(TRANSLATE_CONTENT_KEY);
		return !!v?.[TRANSLATE_CONTENT_KEY];
	} catch {
		return false;
	}
}
export async function setTranslateContent(on) {
	translateContent = !!on;
	try {
		await chrome.storage.sync.set({ [TRANSLATE_CONTENT_KEY]: translateContent });
	} catch {}
}

function pickVoice(locale) {
	const voices = self.speechSynthesis?.getVoices?.() || [];
	const want = locale.toLowerCase();
	const base = want.split("-")[0];
	let best = null;
	let bestScore = -1;
	for (const v of voices) {
		const l = String(v.lang || "")
			.toLowerCase()
			.replace("_", "-");
		if (!l.startsWith(base)) continue;
		const score = (v.localService ? 4 : 0) + (l === want ? 2 : 1); // on-device voices first
		if (score > bestScore) {
			bestScore = score;
			best = v;
		}
	}
	return best;
}

// actions.js speak() awaits onend/onerror. Any utterance we decide not to speak
// must still "end", or that await never resolves.
function finishUnspoken(utter) {
	try {
		utter.dispatchEvent(new Event("end"));
	} catch {}
}

let speakChain = Promise.resolve();
let speakGen = 0;

// Install AFTER any transcript-logging patch so the transcript shows what is spoken.
export function installSpeechTranslation() {
	const synth = self.speechSynthesis;
	if (!synth || synth.__canvoxLangPatched) return;
	synth.__canvoxLangPatched = true;

	try {
		chrome.storage.sync.get(TRANSLATE_CONTENT_KEY).then((v) => {
			translateContent = !!v?.[TRANSLATE_CONTENT_KEY];
		});
		chrome.storage.onChanged.addListener((changes, area) => {
			if (area === "sync" && changes[TRANSLATE_CONTENT_KEY]) {
				translateContent = !!changes[TRANSLATE_CONTENT_KEY].newValue;
			}
		});
	} catch {}

	const innerSpeak = synth.speak.bind(synth);
	const innerCancel = synth.cancel.bind(synth);

	synth.cancel = () => {
		speakGen++; // anything still translating is dropped (and "ended")
		speakChain = Promise.resolve();
		return innerCancel();
	};

	synth.speak = (utter) => {
		if (getLang() === "en" || !utter) return innerSpeak(utter);

		const gen = speakGen;
		speakChain = speakChain
			.then(async () => {
				if (gen !== speakGen) return finishUnspoken(utter);

				const keepOriginal = CONTENT.has(utter) && !translateContent;
				let inUserLang = LOCALIZED.has(utter);
				if (!inUserLang && !keepOriginal) {
					const out = await fromEnglish(utter.text);
					if (out != null) {
						utter.text = out;
						inUserLang = true;
					}
				}
				if (gen !== speakGen) return finishUnspoken(utter);

				if (inUserLang) {
					utter.lang = speechLocale();
					const v = pickVoice(utter.lang);
					if (v) utter.voice = v;
				}
				innerSpeak(utter);
			})
			.catch(() => {
				if (gen === speakGen) innerSpeak(utter);
				else finishUnspoken(utter);
			});
	};
}

// ---------------------------------------------------------------------------
// On-device speech recognition (voice input without Google's servers)
// ---------------------------------------------------------------------------
// Chrome's Web Speech API sends audio to Google by default. Recent Chrome
// versions can also recognize speech on-device once a language pack is
// installed (SpeechRecognition.available / .install and the processLocally
// flag). Everything here is feature-detected: on older Chrome these return
// "unsupported"/false and voice input keeps working exactly as before (online).
// Verify the API surface on the Chrome version your team targets.
function speechRecognitionClass() {
	return self.SpeechRecognition || self.webkitSpeechRecognition || null;
}

// "unsupported" | "unavailable" | "downloadable" | "downloading" | "available"
export async function localSpeechStatus(locale) {
	const SR = speechRecognitionClass();
	if (typeof SR?.available !== "function") return "unsupported";
	try {
		return await SR.available({ langs: [locale], processLocally: true });
	} catch {
		return "unavailable";
	}
}

// Call synchronously inside a click/keydown handler (a download may be needed).
export async function installLocalSpeech(locale) {
	const SR = speechRecognitionClass();
	if (typeof SR?.install !== "function") return false;
	try {
		return !!(await SR.install({ langs: [locale], processLocally: true }));
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Bridge for lib/actions.js: lets it call these helpers WITHOUT a static import,
// so English keeps working even if this module fails to load.
// ---------------------------------------------------------------------------
const __CONVOX = (globalThis.__CONVOX ||= {});
__CONVOX.lang = { getLang, speechLocale, markLocalized, markContent };
