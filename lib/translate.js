// lib/translate.js
/** @type {any} */
const Translator = self.Translator;
const translators = new Map(); // lang -> Translator instance

function supported() {
	return typeof self !== "undefined" && "Translator" in self;
}

async function status(src) {
	return Translator.availability({ sourceLanguage: src, targetLanguage: "en" });
}

// Call from a user gesture (popup language selector click).
export async function warmUpTranslator(lang = "es", onProgress) {
	const src = lang.slice(0, 2);
	if (src === "en" || !supported()) return "unsupported";
	if (translators.has(src)) return "available";
	if ((await status(src)) === "unavailable") return "unavailable";

	const t = await Translator.create({
		sourceLanguage: src,
		targetLanguage: "en",
		monitor(m) {
			m.addEventListener("downloadprogress", (e) => onProgress?.(e.loaded));
		},
	});
	translators.set(src, t);
	return "available";
}

// Returns { text, translated, via } so callers can react to failure.
export async function translateToEnglish(text, sourceLang = "es") {
	const src = sourceLang.slice(0, 2);
	if (!text || src === "en") return { text, translated: false, via: "none" };

	try {
		if (supported()) {
			let t = translators.get(src);
			if (!t && (await status(src)) === "available") {
				t = await Translator.create({ sourceLanguage: src, targetLanguage: "en" });
				translators.set(src, t);
			}
			if (t) return { text: await t.translate(text), translated: true, via: "chrome" };
		}
	} catch (err) {
		console.warn("[translate] Chrome translator failed:", err);
	}
	// Optional: try your backend route here before giving up.
	return { text, translated: false, via: "none" };
}