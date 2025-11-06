// src/content/canvasPptSummarizer.js
// ALWAYS download and summarize the actual file (PDF/PPTX/PPT).
// Robust to service worker restarts; prefers same-origin fetch; SW only for cross-origin.

(() => {
  // ===== small utils =====
  const WORD_RE = /[a-z0-9][a-z0-9\-']+/gi;
  const STOP = new Set(("a,an,and,are,as,at,be,by,for,from,has,have,he,her,his,i,in,is,it,its,of,on,or,our,that,the,them,they,this,to,was,were,will,with,about,across,after,against,all,also,am,any,around,back,been,before,being,both,can,could,did,do,does,doing,down,during,each,few,had,if,into,just,like,more,most,near,no,not,now,off,once,one,only,other,out,over,same,should,so,some,such,than,then,there,these,those,through,too,under,up,very,via,vs,well,what,when,where,which,who,why,yes,you,your").split(","));
  const log = (...a) => console.log("[Canvox Summarizer]", ...a);
  const warn = (...a) => console.warn("[Canvox Summarizer]", ...a);
  const byId = id => document.getElementById(id);

  // ===== UI =====
  function injectButton() {
    if (byId("cvx-ppt-summarize")) return;
    const btn = document.createElement("button");
    btn.id = "cvx-ppt-summarize";
    btn.textContent = "Summarize slide deck";
    Object.assign(btn.style, {
      position: "fixed", bottom: "16px", right: "16px", zIndex: 2147483647,
      padding: "10px 12px", borderRadius: "10px", border: "none",
      fontSize: "14px", fontWeight: 600, cursor: "pointer",
      background: "#0b5cff", color: "#fff", boxShadow: "0 2px 8px rgba(0,0,0,.25)"
    });
    btn.addEventListener("click", onSummarize);
    document.documentElement.appendChild(btn);
  }
  function toast(msg) {
    const id = "cvx-ppt-toast";
    let t = byId(id);
    if (!t) {
      t = document.createElement("div");
      t.id = id;
      Object.assign(t.style, {
        position: "fixed", bottom: "64px", right: "16px", maxWidth: "420px",
        background: "rgba(0,0,0,.85)", color: "#fff", padding: "10px 12px",
        borderRadius: "10px", fontSize: "13px", lineHeight: "1.35",
        zIndex: 2147483647
      });
      t.setAttribute("role", "status");
      document.documentElement.appendChild(t);
    }
    t.textContent = msg;
    clearTimeout(t._h); t._h = setTimeout(() => t.remove(), 4000);
  }

  // ===== safe BG messaging with auto-retry (handles “context invalidated”) =====
  function sendBG(payload, retries = 4, delay = 250) {
    return new Promise(resolve => {
      const trySend = (left) => {
        try {
          chrome.runtime.sendMessage(payload, (resp) => {
            const err = chrome.runtime.lastError;
            if (err) {
              const m = String(err.message || "");
              if (left > 0 && /(context invalidated|Receiving end does not exist)/i.test(m)) {
                // ping to wake the SW, then retry
                chrome.runtime.sendMessage({ type: "cvxPing" }, () => {
                  setTimeout(() => trySend(left - 1), delay);
                });
              } else {
                resolve(null);
              }
            } else {
              resolve(resp || null);
            }
          });
        } catch (_) {
          resolve(null);
        }
      };
      trySend(retries);
    });
  }
  const bgText = (url, opt = {}) => sendBG({ type: "cvxFetch", url, responseType: "text", ...opt });
  const bgABuf = (url, opt = {}) => sendBG({ type: "cvxFetch", url, responseType: "arraybuffer", ...opt });

  function b64ToU8(b64) {
    const bin = atob(b64 || ""); const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  }

  // ===== Canvas helpers =====
  function getCourseId() {
    const m = location.pathname.match(/\/courses\/(\d+)/);
    return m ? m[1] : "";
  }
  function getFileId() {
    const m = location.pathname.match(/\/courses\/\d+\/files\/(\d+)/);
    if (m) return m[1];
    // try to glean from DOM
    for (const a of document.querySelectorAll('a[href]')) {
      const mm = (a.getAttribute("href") || "").match(/\/files\/(\d+)/);
      if (mm) return mm[1];
    }
    return "";
  }

  // Prefer same-origin fetch (cheap, no SW), then fall back to SW
  async function apiJSON(path, method = "GET") {
    const abs = new URL(path, location.origin).toString();
    try {
      const res = await fetch(abs, {
        method,
        credentials: "include",
        headers: { "Accept": "application/json" },
        cache: "no-store",
        redirect: "follow"
      });
      if (res.ok) return await res.json();
    } catch (_) {}
    const bg = await bgText(abs, { method, headers: { "Accept": "application/json" } });
    if (!bg?.ok) throw new Error(`API ERR ${bg?.status || 0} ${path}`);
    try { return JSON.parse(bg.text || "{}"); } catch { return {}; }
  }

  function findDownloadHrefInDOM() {
    const direct = Array.from(document.querySelectorAll('a[href*="/download"], a[href$=".pdf"], a[href$=".ppt"], a[href$=".pptx"]'));
    for (const a of direct) {
      try {
        const u = new URL(a.getAttribute("href"), location.href).toString();
        if (/\/files\/\d+\/download/i.test(u) || /\.(pdf|pptx?|pptm)(\b|\?)/i.test(u)) return u;
      } catch {}
    }
    return null;
  }

  async function discoverCandidates(fid) {
    const urls = new Set();
    const dom = findDownloadHrefInDOM();
    if (dom) urls.add(dom);

    // Canvas meta
    try {
      const meta = await apiJSON(`/api/v1/files/${fid}?include[]=url&include[]=preview_url&include[]=enhanced_preview_url`);
      if (meta.url) urls.add(meta.url);
      if (meta.preview_url) urls.add(new URL(meta.preview_url, location.origin).toString());
      const cid = getCourseId();
      if (cid) {
        urls.add(`${location.origin}/courses/${cid}/files/${fid}/download?download_frd=1`);
        urls.add(`${location.origin}/courses/${cid}/files/${fid}/download`);
        urls.add(`${location.origin}/courses/${cid}/files/${fid}/preview`);
      }
    } catch (e) {
      warn("Files meta failed:", e?.message || e);
    }

    // public_url
    for (const method of ["GET", "POST"]) {
      try {
        const pub = await apiJSON(`/api/v1/files/${fid}/public_url`, method);
        if (pub?.public_url) urls.add(pub.public_url);
      } catch (_) {}
    }

    // scan page
    document.querySelectorAll('a[href], iframe[src], embed[src], object[data]').forEach(el => {
      const u = el.getAttribute('href') || el.getAttribute('src') || el.getAttribute('data') || "";
      if (!u) return;
      try {
        const abs = new URL(u, location.href).toString();
        if (
          /\.pdf(\b|\?)/i.test(abs) || /\.pptx?(\b|\?)/i.test(abs) ||
          /\/download(\b|\?)/i.test(abs) ||
          /officeapps\.live\.com|office\.net/i.test(abs)
        ) urls.add(abs);
      } catch {}
    });

    const list = Array.from(urls);
    log("candidates:", list);
    return list;
  }

  // ===== parsers =====
  async function loadPdfJs() {
    if (window.__cvx_pdfjs) return window.__cvx_pdfjs;
    const m = await import(chrome.runtime.getURL("lib/pdfjs/pdf.mjs"));
    m.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdfjs/pdf.worker.mjs");
    window.__cvx_pdfjs = m;
    return m;
  }
  function looksPdf(u8) {
    return u8[0] === 0x25 && u8[1] === 0x50 && u8[2] === 0x44 && u8[3] === 0x46;
  }
  async function parsePDF(u8) {
    const pdfjs = await loadPdfJs();
    const doc = await pdfjs.getDocument({ data: u8 }).promise;
    const out = [];
    const maxPages = Math.min(doc.numPages, 60);
    for (let i = 1; i <= maxPages; i++) {
      const page = await doc.getPage(i);
      const c = await page.getTextContent({ includeMarkedContent: true });
      const t = c.items.map(it => it.str).join(" ").replace(/\s+/g, " ").trim();
      if (t) out.push(t);
    }
    return { texts: out, pages: doc.numPages };
  }

  async function loadJSZip() {
    if (window.__cvx_jszip) return window.__cvx_jszip;
    const mod = await import(chrome.runtime.getURL("lib/jszip/jszip.min.js"));
    const JSZip = mod?.default || self.JSZip;
    window.__cvx_jszip = JSZip;
    return JSZip;
  }
  async function parsePPTX(u8) {
    const JSZip = await loadJSZip();
    const zip = await JSZip.loadAsync(u8);
    const slideNames = Object.keys(zip.files)
      .filter(n => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
      .sort((a,b) => (+a.match(/slide(\d+)/i)[1]) - (+b.match(/slide(\d+)/i)[1]));
    const out = [];
    for (const name of slideNames) {
      const xml = await zip.file(name).async("string");
      const matches = xml.match(/<a:t[^>]*>([\s\S]*?)<\/a:t>/gi) || [];
      const pieces = matches.map(m => m.replace(/<\/?a:t[^>]*>/gi, "").replace(/\s+/g, " ").trim()).filter(Boolean);
      const merged = pieces.join(" ").trim();
      if (merged) out.push(merged);
    }
    return { texts: out, pages: slideNames.length || out.length || 1 };
  }

  function parsePPT_legacy(u8) {
    const texts = new Set();
    // UTF-16LE runs
    let i = 0;
    while (i + 1 < u8.length) {
      const start = i, chars = [];
      while (i + 1 < u8.length) {
        const lo = u8[i], hi = u8[i + 1];
        if (hi === 0x00 && lo >= 32 && lo <= 126) { chars.push(lo); i += 2; } else break;
      }
      if (chars.length >= 6) texts.add(String.fromCharCode(...chars).replace(/\s+/g, " ").trim());
      if (i === start) i++;
    }
    // ASCII runs
    i = 0;
    while (i < u8.length) {
      const start = i;
      while (i < u8.length && u8[i] >= 32 && u8[i] <= 126) i++;
      const len = i - start;
      if (len >= 6) {
        let s = "";
        for (let j = start; j < i; j++) s += String.fromCharCode(u8[j]);
        s = s.replace(/\s+/g, " ").trim();
        if (s) texts.add(s);
      }
      i++;
    }
    const BOILER = [/PowerPoint is starting/i, /We're fetching your file/i, /Please wait/i];
    const out = Array.from(texts).filter(t => !BOILER.some(rx => rx.test(t)));
    return { texts: out, pages: Math.max(1, Math.round(out.length / 2)) };
  }

  function linksFromHTML(html, baseUrl) {
    const set = new Set();
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll('a[href], iframe[src], embed[src], object[data]').forEach(el => {
      const u = el.getAttribute('href') || el.getAttribute('src') || el.getAttribute('data') || "";
      if (!u) return;
      try {
        const abs = new URL(u, baseUrl).toString();
        if (/\.pdf(\b|\?)/i.test(abs) || /\.pptx?(\b|\?)/i.test(abs) || /\/download(\b|\?)/i.test(abs)) set.add(abs);
      } catch {}
    });
    return Array.from(set);
  }

  async function fetchAndParse(url, depth = 0, visited = new Set()) {
    if (depth > 4 || visited.has(url)) return { texts: [], pages: 0 };
    visited.add(url);
    log("fetch:", url);

    const head = await bgText(url, { method: "GET" });
    if (!head?.ok) return { texts: [], pages: 0 };

    const ct = (head.contentType || "").toLowerCase();
    const final = head.url || url;

    if (ct.includes("text/html")) {
      const html = head.text || "";
      const found = linksFromHTML(html, final);
      for (const nxt of found) {
        const r = await fetchAndParse(nxt, depth + 1, visited);
        if (r.texts.length) return r;
      }
      return { texts: [], pages: 0 };
    }

    const bin = await bgABuf(final);
    if (!bin?.ok) return { texts: [], pages: 0 };
    const u8 = b64ToU8(bin.base64);

    if (looksPdf(u8) || /\.pdf(\b|\?)/i.test(final) || ct.includes("/pdf")) {
      return await parsePDF(u8);
    }
    if (/\.pptx(\b|\?)/i.test(final) || ct.includes("officedocument.presentationml.presentation")) {
      try { return await parsePPTX(u8); } catch { return parsePPT_legacy(u8); }
    }
    if (/\.ppt(\b|\?)/i.test(final) || ct.includes("vnd.ms-powerpoint")) {
      return parsePPT_legacy(u8);
    }

    return { texts: [], pages: 0 };
  }

  // ===== summarizer (FIXED LENGTH, no slide count in output) =====
  function summarize(texts) {
    if (!Array.isArray(texts) || !texts.length) {
      return "This document has little or no selectable text (likely image-only slides).";
    }
    const TARGET_WORDS = 50;

    const all = texts.join(" ");
    const tokens = (all.toLowerCase().match(WORD_RE) || []);
    const freq = Object.create(null);
    for (const w of tokens) if (!STOP.has(w) && w.length >= 3) freq[w] = (freq[w] || 0) + 1;

    const frags = [];
    for (const s of texts) s.split(/[\n\r;•–—\-|•]+/).forEach(r => {
      const t = r.trim();
      if (t.length > 2) frags.push(t);
    });

    const scored = frags.map(text => {
      const parts = text.toLowerCase().match(WORD_RE) || [];
      let score = 0; for (const p of parts) score += (freq[p] || 0);
      return { text, score };
    }).sort((a, b) => b.score - a.score);

    const top = Object.entries(freq).sort((a, b) => b[1] - a[1]).map(([w]) => w);
    const kwHead = top.slice(0, 5).join(", ");
    const kwTail = top.slice(5, 8).join(", ");
    const highlights = scored.slice(0, 3).map(s => s.text);

    const parts = [];
    if (kwHead) parts.push(`Overview: ${kwHead}.`);
    if (highlights.length) parts.push(`Key points: ${highlights.join("; ")}.`);
    if (kwTail) parts.push(`Focus areas include ${kwTail}.`);

    let summary = parts.join(" ").replace(/\s+/g, " ").trim();
    const wc = (summary.match(/\S+/g) || []).length;
    if (wc > TARGET_WORDS) summary = summary.split(/\s+/).slice(0, TARGET_WORDS).join(" ") + (/[.!?]$/.test(summary) ? "" : ".");
    else if (wc < 30) {
      const extras = scored.slice(3, 6).map(s => s.text).join(" ");
      summary = (summary + " " + extras).replace(/\s+/g, " ").trim();
      const wc2 = (summary.match(/\S+/g) || []).length;
      if (wc2 > TARGET_WORDS) summary = summary.split(/\s+/).slice(0, TARGET_WORDS).join(" ") + ".";
    }
    return summary;
  }

  async function copyToClipboard(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch {
      const ta = document.createElement("textarea");
      ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.left = "-9999px";
      document.body.appendChild(ta); ta.select();
      try { const ok = document.execCommand("copy"); document.body.removeChild(ta); return ok; }
      catch { document.body.removeChild(ta); return false; }
    }
  }
  function speak(text) {
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      chrome.storage?.sync?.get({ voiceVolume: 1.0, voiceRate: 1.0 }, (cfg) => {
        u.volume = Math.max(0, Math.min(1, cfg.voiceVolume));
        u.rate = Math.max(0.5, Math.min(2, cfg.voiceRate));
        window.speechSynthesis.speak(u);
      });
    } catch {}
  }

  // ===== hotkey: press "s" to summarize (ignored while typing) =====
  function isTypingTarget(el) {
    if (!el) return false;
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || el.isContentEditable) return true;
    return !!el.closest?.('[contenteditable=""], [contenteditable="true"], .tox-edit-area, .mce-content-body');
  }
  function onKeydownSummarize(e) {
    if (e.key && e.key.toLowerCase() === "s" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (isTypingTarget(e.target)) return;
      const btn = document.getElementById("cvx-ppt-summarize");
      if (btn && !btn.disabled) { e.preventDefault(); btn.click(); }
    }
  }

  // ===== handler =====
  async function onSummarize(e) {
    const btn = e.currentTarget;
    const prev = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Summarizing…";

    try {
      const fid = getFileId();
      if (!fid) throw new Error("No Canvas file id on this page.");

      const candidates = await discoverCandidates(fid);
      let texts = [], pages = 0;

      for (const url of candidates) {
        try {
          const r = await fetchAndParse(url);
          if (r.texts.length) { texts = r.texts; pages = r.pages; break; }
        } catch (ex) {
          warn("candidate failed:", url, ex?.message || ex);
        }
      }

      if (!texts.length) {
        warn("no texts after retries");
        toast("Couldn't get slide text (likely image-only or protected).");
        return;
      }

      const summary = summarize(texts);
      console.log("[Canvox Summarizer] SUMMARY:", summary);
      const copied = await copyToClipboard(summary);
      toast(`Summary ${copied ? "copied" : "ready"} (${(summary.match(/\S+/g) || []).length} words).`);
      speak(summary);
    } catch (ex) {
      warn("Summarize failed:", ex?.message || ex);
      toast("Failed to summarize this document.");
      speak("Failed to summarize this document.");
    } finally {
      btn.disabled = false; btn.textContent = prev;
    }
  }

  function start() {
    injectButton();

    // keep button alive
    const obs = new MutationObserver(() => { if (!byId("cvx-ppt-summarize")) injectButton(); });
    obs.observe(document.documentElement, { childList: true, subtree: true });

    // NEW: press "s" to summarize
    window.addEventListener("keydown", onKeydownSummarize, true);

    log("Loaded (resilient SW + offline parsing + 'S' hotkey + fixed summary) on", location.href);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
