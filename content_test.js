// content_test.js
// Convox Test Harness UI (MV3 content script)
// - Accessible, draggable, collapsible, debug-friendly
// - Cross-platform shortcuts (Mac + Windows/Linux) — FIXED on Mac by using e.code
// - Persists transcript + UI state (position, minimized, collapsed panels, verbosity)
//
// Notes:
// - This runs on the Canvas page context as a content script.
// - It dynamically imports extension modules via chrome.runtime.getURL(...).

(async () => {
  // ===========================================================================
  // Helpers / State
  // ===========================================================================
  const STORE_KEY = "convox_test_transcript_v3";
  const UI_KEY = "convox_test_ui_state_v3";

  const isMac =
    navigator.userAgentData?.platform
      ? /mac/i.test(navigator.userAgentData.platform)
      : /Mac|iPhone|iPad|iPod/i.test(navigator.platform || "");

  // Mac: Option (⌥). Win/Linux: Ctrl+Alt.
  // Also allow Cmd+Option on Mac (some people prefer it / fewer conflicts).
  const SHORTCUT_PREFIX = isMac ? "⌥" : "Ctrl+Alt";
  const UI_TITLE = "Convox Test";

  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const safeJSONParse = (s, fallback) => {
    try {
      return JSON.parse(s);
    } catch {
      return fallback;
    }
  };

  function logToast(msg, ...rest) {
    console.log("[Convox Test]", msg, ...rest);
  }

  function nowTS() {
    try {
      return new Date().toLocaleTimeString();
    } catch {
      return "";
    }
  }

  function loadTranscript() {
    const raw = localStorage.getItem(STORE_KEY);
    const arr = safeJSONParse(raw, []);
    return Array.isArray(arr) ? arr : [];
  }

  function saveTranscript(convo) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(convo));
    } catch (e) {
      console.warn("[Convox Test] Failed to persist transcript:", e);
    }
  }

  function loadUIState() {
    const raw = localStorage.getItem(UI_KEY);
    const st = safeJSONParse(raw, {});
    return st && typeof st === "object" ? st : {};
  }

  function saveUIState(patch) {
    const cur = loadUIState();
    const next = { ...cur, ...patch };
    try {
      localStorage.setItem(UI_KEY, JSON.stringify(next));
    } catch {}
    return next;
  }

  let convo = loadTranscript(); // { role: "user"|"convox"|"system", text, ts, level? }

  function pushConvo(role, text, level = "info") {
    const line = String(text ?? "").trim();
    if (!line) return;
    convo.push({ role, text: line, ts: nowTS(), level });
    saveTranscript(convo);
    renderLog();
    announce(`${role === "user" ? "You" : role === "convox" ? "Convox" : "System"}: ${line}`);
  }

  function convoToText(filtered = null) {
    const rows = filtered ? convo.filter(filtered) : convo;
    return rows
      .map((m) => {
        const who = m.role === "user" ? "You" : m.role === "convox" ? "Convox" : "System";
        const lvl = (m.level || "info").toUpperCase();
        return `[${m.ts}] ${who} (${lvl}): ${m.text}`;
      })
      .join("\n");
  }

  // ===========================================================================
  // TTS capture (monkey-patch)
  // ===========================================================================
  let ttsPatched = false;
  function patchTTSOnce() {
    if (ttsPatched) return;
    ttsPatched = true;

    if (!("speechSynthesis" in window) || typeof window.speechSynthesis?.speak !== "function") {
      pushConvo("system", "speechSynthesis not available; cannot capture Convox speech.", "warn");
      return;
    }

    const synth = window.speechSynthesis;
    const originalSpeak = synth.speak.bind(synth);

    synth.speak = (utter) => {
      try {
        const spoken = utter?.text ?? "";
        if (spoken) pushConvo("convox", spoken, "info");
      } catch {}
      return originalSpeak(utter);
    };

    pushConvo("system", "TTS capture enabled (Convox speech will appear in transcript).", "info");
  }

  // ===========================================================================
  // Robust importer with one-time auto-reload
  // ===========================================================================
  let reloadedOnce = false;

  async function safeImportActions() {
    const ver = chrome?.runtime?.getManifest?.()?.version || "dev";
    const url = chrome.runtime.getURL(`lib/actions.js?v=${encodeURIComponent(ver)}`);

    try {
      return await import(url);
    } catch (err) {
      const msg = String(err?.message || err);

      if (msg.includes("Failed to fetch dynamically imported module") || msg.includes("Denying load of")) {
        pushConvo(
          "system",
          "Import blocked by manifest. Fix: add lib/*.js to web_accessible_resources and reload the extension.",
          "error"
        );
      } else if (msg.includes("Relative references must start")) {
        pushConvo(
          "system",
          "Import failed: a module uses a bare import. In extensions, imports must be './file.js' or a full chrome.runtime URL.",
          "error"
        );
      } else if (msg.includes("Extension context invalidated")) {
        logToast("Detected invalidated context. Attempting one-time page reload to re-inject content script.");
        if (!reloadedOnce) {
          reloadedOnce = true;
          alert("Convox was reloaded. I’ll refresh this page once so testing can continue.");
          location.reload();
        }
      } else {
        pushConvo("system", `Import failed: ${msg}`, "error");
      }

      throw err;
    }
  }

  // ===========================================================================
  // Actions runner
  // ===========================================================================
  async function runUtterance(text) {
    const uiSt = loadUIState();
    const verbose = !!uiSt.verbose;

    try {
      const { handleUtterance, initAutoResume } = await safeImportActions();
      initAutoResume?.();

      pushConvo("user", text, "info");

      const t0 = performance.now();
      const out = await handleUtterance(text);
      const dt = Math.round(performance.now() - t0);

      if (verbose) logToast("handleUtterance output:", out);

      try {
        const intent = out?.intent || "UNKNOWN";
        const conf = out?.result?.confidence;
        const reason = out?.result?.reason;
        const meta =
          typeof conf === "number"
            ? `Intent: ${intent} (conf ${conf.toFixed(2)})${reason ? ` — ${reason}` : ""} • ${dt}ms`
            : `Intent: ${intent}${reason ? ` — ${reason}` : ""} • ${dt}ms`;
        pushConvo("system", meta, "debug");
      } catch {}
    } catch (e) {
      const msg = String(e?.message || e);
      pushConvo("system", "Error: " + msg, "error");

      // Keep last error around for sponsor demos
      saveUIState({ lastError: msg, lastErrorAt: new Date().toISOString() });

      try {
        const u = new SpeechSynthesisUtterance("Sorry — I hit an error. Check the console for details.");
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(u);
      } catch {}
    }
  }

  // ===========================================================================
  // Diagnose
  // ===========================================================================
  async function diagnose() {
    const parts = [];
    parts.push(`URL: ${location.host}${location.pathname}`);
    parts.push(`speechSynthesis: ${"speechSynthesis" in window ? "available" : "missing"}`);

    const links = Array.from(document.querySelectorAll("a, [role='link']"));
    const sample = links
      .slice(0, 10)
      .map((a) => (a.textContent || "").trim())
      .filter(Boolean)
      .slice(0, 5);

    parts.push(`links on page: ${links.length} (sample: ${sample.join(" | ") || "—"})`);

    try {
      const { speak } = await safeImportActions();
      speak?.("Convox self-test: Speech is working.");
      parts.push("TTS check: attempted to speak a test line.");
    } catch {
      parts.push("TTS check: failed to import speak()");
    }

    alert(`${UI_TITLE} Diagnose:\n\n` + parts.join("\n"));
  }

  // ===========================================================================
  // UI Elements
  // ===========================================================================
  let container = null;
  let content = null;

  // Log UI (now structured, not textarea)
  let logWrap = null;
  let logListEl = null;
  let searchEl = null;

  let inputEl = null;
  let announceEl = null;

  let helpBtn = null;
  let minimizeBtn = null;
  let copyBtn = null;
  let clearBtn = null;
  let diagBtn = null;
  let stopSpeakBtn = null;
  let micBtn = null;
  let submitBtn = null;
  let verboseBtn = null;
  let collapseLogBtn = null;
  let collapseControlsBtn = null;

  // Speech recognition
  let recognizer = null;
  let listening = false;
  let autoSubmitTimer = null;

  // ===========================================================================
  // Accessibility: live region announcements
  // ===========================================================================
  function announce(text) {
    if (!announceEl) return;
    const t = String(text || "").trim();
    if (!t) return;

    announceEl.textContent = "";
    setTimeout(() => {
      announceEl.textContent = t.slice(0, 180);
    }, 10);
  }

  // ===========================================================================
  // Render transcript (readable lines + filters + search)
  // ===========================================================================
  function renderLog() {
    if (!logListEl) return;

    const uiSt = loadUIState();
    const showDebug = !!uiSt.showDebug;
    const showErrorsOnly = !!uiSt.showErrorsOnly;

    const q = String(searchEl?.value || "").trim().toLowerCase();

    const filtered = (m) => {
      if (showErrorsOnly) return m.level === "error" || (m.role === "system" && m.level !== "debug");
      if (!showDebug && m.level === "debug") return false;
      if (q) {
        const hay = `${m.ts} ${m.role} ${m.level} ${m.text}`.toLowerCase();
        return hay.includes(q);
      }
      return true;
    };

    const rows = convo.filter(filtered);

    logListEl.innerHTML = "";
    const frag = document.createDocumentFragment();

    if (rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "cx-log-empty";
      empty.textContent = q ? "No matches." : "No logs yet.";
      frag.appendChild(empty);
    } else {
      for (const m of rows) {
        const line = document.createElement("div");
        line.className = `cx-line cx-role-${m.role} cx-lvl-${m.level || "info"}`;

        const ts = document.createElement("span");
        ts.className = "cx-ts";
        ts.textContent = m.ts || "";
        line.appendChild(ts);

        const badge = document.createElement("span");
        badge.className = "cx-badge";
        badge.textContent = m.role === "user" ? "YOU" : m.role === "convox" ? "CONVOX" : "SYSTEM";
        line.appendChild(badge);

        const lvl = document.createElement("span");
        lvl.className = "cx-lvl";
        const level = m.level || "info";
        lvl.textContent =
          level === "error" ? "⛔" :
          level === "warn"  ? "⚠️" :
          level === "debug" ? "🧪" : "•";
        lvl.title = level.toUpperCase();
        line.appendChild(lvl);

        const msg = document.createElement("span");
        msg.className = "cx-msg";
        msg.textContent = m.text || "";
        line.appendChild(msg);

        frag.appendChild(line);
      }
    }

    logListEl.appendChild(frag);

    // autoscroll if user is near bottom
    try {
      const nearBottom =
        logWrap.scrollHeight - logWrap.scrollTop - logWrap.clientHeight < 120;
      if (nearBottom) logWrap.scrollTop = logWrap.scrollHeight;
    } catch {}
  }

  // ===========================================================================
  // Clipboard / clear / stop
  // ===========================================================================
  async function copyConversation() {
    const uiSt = loadUIState();
    const showDebug = !!uiSt.showDebug;
    const showErrorsOnly = !!uiSt.showErrorsOnly;
    const q = String(searchEl?.value || "").trim().toLowerCase();

    const filtered = (m) => {
      if (showErrorsOnly) return m.level === "error" || (m.role === "system" && m.level !== "debug");
      if (!showDebug && m.level === "debug") return false;
      if (q) {
        const hay = `${m.ts} ${m.role} ${m.level} ${m.text}`.toLowerCase();
        return hay.includes(q);
      }
      return true;
    };

    const txt = convoToText(filtered);

    try {
      await navigator.clipboard.writeText(txt);
      pushConvo("system", "Conversation copied to clipboard.", "info");
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = txt;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        pushConvo("system", "Conversation copied to clipboard.", "info");
      } catch {
        alert("Copy failed. You can manually select and copy from the log box.");
      }
    }
  }

  function clearConversation() {
    convo = [];
    try {
      localStorage.removeItem(STORE_KEY);
    } catch {}
    pushConvo("system", "Conversation cleared.", "info");
    renderLog();
  }

  function stopSpeaking() {
    try {
      window.speechSynthesis?.cancel?.();
      pushConvo("system", "Stopped speaking.", "info");
    } catch {}
  }

  function stopListening() {
    try {
      recognizer?.stop?.();
    } catch {}
  }

  // ===========================================================================
  // Shortcut help (cross-platform)
  // ===========================================================================
  function shortcutLabel(key) {
    return `${SHORTCUT_PREFIX}+${key.toUpperCase()}`;
  }

  function speakHelp() {
    const msg =
      `${UI_TITLE} shortcuts: ` +
      `${shortcutLabel("L")} listen/stop. ` +
      `${shortcutLabel("S")} submit. ` +
      `${shortcutLabel("X")} stop speaking. ` +
      `${shortcutLabel("C")} copy. ` +
      `${shortcutLabel("R")} clear. ` +
      `${shortcutLabel("H")} help. ` +
      `${shortcutLabel("M")} minimize/show. ` +
      `${shortcutLabel("D")} diagnose. ` +
      `${shortcutLabel("F")} focus input. ` +
      `${shortcutLabel("G")} toggle debug lines. ` +
      `${shortcutLabel("E")} errors-only view. ` +
      `${shortcutLabel("V")} verbose console logging. ` +
      `Press Escape to stop listening/speaking.`;

    pushConvo("system", "Help: " + msg, "info");

    try {
      const u = new SpeechSynthesisUtterance(msg);
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch {}
  }

  // ===========================================================================
  // UI Minimize / Collapse panels
  // ===========================================================================
  function setMinimized(minimized) {
    if (!content) return;
    content.style.display = minimized ? "none" : "block";
    minimizeBtn.textContent = minimized ? "➕ Show" : "➖ Min";
    minimizeBtn.setAttribute("aria-pressed", minimized ? "true" : "false");
    saveUIState({ minimized });
  }

  function setCollapsed(section, collapsed) {
    const uiSt = loadUIState();
    const next = { ...(uiSt.collapsed || {}), [section]: !!collapsed };
    saveUIState({ collapsed: next });
    applyCollapsedState();
  }

  function applyCollapsedState() {
    const uiSt = loadUIState();
    const collapsed = uiSt.collapsed || {};
    const logWrapEl = document.getElementById("convox-test-log-wrap");
    const controlsWrap = document.getElementById("convox-test-controls-wrap");

    if (logWrapEl) logWrapEl.style.display = collapsed.log ? "none" : "block";
    if (controlsWrap) controlsWrap.style.display = collapsed.controls ? "none" : "block";

    if (collapseLogBtn) {
      collapseLogBtn.textContent = collapsed.log ? "📜 Show Log" : "📜 Hide Log";
      collapseLogBtn.setAttribute("aria-pressed", collapsed.log ? "true" : "false");
    }
    if (collapseControlsBtn) {
      collapseControlsBtn.textContent = collapsed.controls ? "🎛️ Show Controls" : "🎛️ Hide Controls";
      collapseControlsBtn.setAttribute("aria-pressed", collapsed.controls ? "true" : "false");
    }
  }

  function focusInput() {
    try {
      inputEl?.focus?.();
    } catch {}
  }

  // ===========================================================================
  // Drag / Move UI (persist position)
  // ===========================================================================
  function getViewportSafePos(x, y, w, h) {
    const pad = 8;
    const maxX = window.innerWidth - w - pad;
    const maxY = window.innerHeight - h - pad;
    return {
      x: clamp(x, pad, Math.max(pad, maxX)),
      y: clamp(y, pad, Math.max(pad, maxY)),
    };
  }

  function applyPositionFromState() {
    if (!container) return;
    const uiSt = loadUIState();
    const pos = uiSt.pos || null;

    if (!pos || typeof pos.x !== "number" || typeof pos.y !== "number") {
      container.style.left = "";
      container.style.top = "";
      container.style.right = "16px";
      container.style.bottom = "16px";
      return;
    }

    container.style.right = "";
    container.style.bottom = "";
    container.style.left = `${pos.x}px`;
    container.style.top = `${pos.y}px`;
  }

  function enableDrag(handleEl) {
    if (!container || !handleEl) return;

    let dragging = false;
    let startX = 0,
      startY = 0;
    let startLeft = 0,
      startTop = 0;

    const onDown = (ev) => {
      if (ev.type === "mousedown" && ev.button !== 0) return;

      dragging = true;
      handleEl.style.cursor = "grabbing";
      container.setAttribute("data-dragging", "true");

      const rect = container.getBoundingClientRect();
      startX = ev.touches ? ev.touches[0].clientX : ev.clientX;
      startY = ev.touches ? ev.touches[0].clientY : ev.clientY;
      startLeft = rect.left;
      startTop = rect.top;

      ev.preventDefault();
    };

    const onMove = (ev) => {
      if (!dragging) return;

      const cx = ev.touches ? ev.touches[0].clientX : ev.clientX;
      const cy = ev.touches ? ev.touches[0].clientY : ev.clientY;

      const dx = cx - startX;
      const dy = cy - startY;

      const rect = container.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;

      const next = getViewportSafePos(startLeft + dx, startTop + dy, w, h);

      container.style.right = "";
      container.style.bottom = "";
      container.style.left = `${next.x}px`;
      container.style.top = `${next.y}px`;

      saveUIState({ pos: { x: next.x, y: next.y } });
    };

    const onUp = () => {
      if (dragging) dragging = false;
      handleEl.style.cursor = "grab";
      container.removeAttribute("data-dragging");
    };

    handleEl.style.cursor = "grab";
    handleEl.addEventListener("mousedown", onDown, { passive: false });
    handleEl.addEventListener("touchstart", onDown, { passive: false });
    window.addEventListener("mousemove", onMove, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: true });
    window.addEventListener("mouseup", onUp, { passive: true });
    window.addEventListener("touchend", onUp, { passive: true });

    window.addEventListener("resize", () => {
      const rect = container.getBoundingClientRect();
      const safe = getViewportSafePos(rect.left, rect.top, rect.width, rect.height);
      container.style.left = `${safe.x}px`;
      container.style.top = `${safe.y}px`;
      saveUIState({ pos: { x: safe.x, y: safe.y } });
    });
  }

  // ===========================================================================
  // Shortcuts — FIXED on Mac (use e.code, not e.key)
  // ===========================================================================
  function keyCodeForLetter(letter) {
    const ch = String(letter || "").toUpperCase();
    return `Key${ch}`;
  }

  function isShortcutChord(e) {
    if (isMac) {
      // Allow ⌥ alone OR ⌘⌥ (both feel natural on Mac)
      return e.altKey && !e.ctrlKey;
    }
    return e.ctrlKey && e.altKey && !e.metaKey;
  }

  function shortcutMatches(e, letter) {
    if (letter === "escape") return e.key === "Escape";
    if (!isShortcutChord(e)) return false;
    return e.code === keyCodeForLetter(letter);
  }

  // ===========================================================================
  // Build UI (accessible + clean)
  // ===========================================================================
  function ensureTestUI() {
    if (document.getElementById("convox-test-container")) return;

    patchTTSOnce();

    const uiSt = loadUIState();
    const minimized = !!uiSt.minimized;

    const style = document.createElement("style");
    style.textContent = `
      #convox-test-container {
        position: fixed;
        z-index: 2147483647;
        font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
        background: #111;
        color: #fff;
        border-radius: 14px;
        box-shadow: 0 8px 28px rgba(0,0,0,0.35);
        padding: 10px;
        width: 420px;
        max-width: min(92vw, 460px);
        border: 1px solid rgba(255,255,255,0.12);
      }
      #convox-test-container * { box-sizing: border-box; }
      #convox-test-title { font-weight: 750; user-select: none; letter-spacing: 0.2px; }
      #convox-test-subtitle { font-size: 12px; opacity: 0.82; margin-top: 2px; }
      .cx-row { display:flex; gap:8px; align-items:center; flex-wrap: wrap; }
      .cx-spread { display:flex; align-items:center; justify-content:space-between; gap:10px; }
      .cx-btn {
        border: none; border-radius: 10px;
        padding: 8px 10px; cursor: pointer;
        background: #2f2f2f; color: #fff;
        font-size: 12px; line-height: 1;
        outline: none;
      }
      .cx-btn:focus { box-shadow: 0 0 0 2px rgba(80,160,255,0.85); }
      .cx-btn-secondary { background: #3a3a3a; }
      .cx-btn-danger { background: #b00020; }
      .cx-btn-primary { background: #28a745; }
      .cx-btn-toggle[aria-pressed="true"] { background: #2b5; color: #071; }
      .cx-input {
        width: 100%; padding: 10px 12px;
        border-radius: 12px; border: 1px solid rgba(255,255,255,0.14);
        background: #0b0b0b; color: #fff;
        font-size: 13px;
      }
      .cx-input:focus { box-shadow: 0 0 0 2px rgba(80,160,255,0.85); outline: none; }
      .cx-chip {
        font-size: 11px; opacity: 0.9;
        padding: 4px 8px; border-radius: 999px;
        border: 1px solid rgba(255,255,255,0.12);
        background: rgba(255,255,255,0.06);
        user-select: none;
      }
      .cx-divider { height: 1px; background: rgba(255,255,255,0.10); margin: 10px 0; }
      .cx-muted { opacity: 0.8; font-size: 12px; }

      /* Log UI (readable) */
      #convox-test-log-wrap { display:block; }
      .cx-log-top { display:flex; gap:8px; align-items:center; margin-bottom: 8px; flex-wrap: wrap; }
      .cx-search {
        flex: 1;
        min-width: 160px;
        padding: 8px 10px;
        border-radius: 10px;
        border: 1px solid rgba(255,255,255,0.14);
        background: #0b0b0b;
        color: #fff;
        font-size: 12px;
      }
      .cx-search:focus { box-shadow: 0 0 0 2px rgba(80,160,255,0.85); outline: none; }

      .cx-logbox {
        width: 100%;
        height: 200px;
        overflow: auto;
        padding: 10px;
        border-radius: 12px;
        border: 1px solid rgba(255,255,255,0.14);
        background: #0b0b0b;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        font-size: 12px;
        line-height: 1.45;
      }
      .cx-log-empty { opacity: 0.75; font-size: 12px; padding: 8px 2px; }

      .cx-line { display:flex; gap:8px; align-items:flex-start; padding: 3px 0; }
      .cx-ts { opacity: 0.65; min-width: 92px; }
      .cx-badge {
        font-size: 10px;
        padding: 2px 6px;
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,0.14);
        opacity: 0.95;
        min-width: 60px;
        text-align: center;
      }
      .cx-lvl { width: 20px; opacity: 0.95; }
      .cx-msg { white-space: pre-wrap; word-break: break-word; flex: 1; }

      .cx-role-user .cx-badge { background: rgba(40,167,69,0.20); border-color: rgba(40,167,69,0.35); }
      .cx-role-convox .cx-badge { background: rgba(80,160,255,0.18); border-color: rgba(80,160,255,0.35); }
      .cx-role-system .cx-badge { background: rgba(255,255,255,0.10); border-color: rgba(255,255,255,0.18); }

      .cx-lvl-error .cx-msg { color: #ffb4b4; }
      .cx-lvl-warn  .cx-msg { color: #ffe2a6; }
      .cx-lvl-debug .cx-msg { color: #c8d7ff; opacity: 0.95; }

      @media (prefers-reduced-motion: reduce) {
        * { scroll-behavior: auto !important; transition: none !important; }
      }
    `;
    document.documentElement.appendChild(style);

    container = document.createElement("div");
    container.id = "convox-test-container";
    container.setAttribute("role", "region");
    container.setAttribute("aria-label", `${UI_TITLE} floating panel`);
    container.style.bottom = "16px";
    container.style.right = "16px";

    // Header (draggable handle)
    const headerRow = document.createElement("div");
    headerRow.className = "cx-spread";
    container.appendChild(headerRow);

    const titleWrap = document.createElement("div");
    titleWrap.style.display = "flex";
    titleWrap.style.flexDirection = "column";
    titleWrap.style.gap = "2px";
    headerRow.appendChild(titleWrap);

    const headerTitle = document.createElement("div");
    headerTitle.id = "convox-test-title";
    headerTitle.textContent = `${UI_TITLE} 🔊`;
    titleWrap.appendChild(headerTitle);

    const headerSub = document.createElement("div");
    headerSub.id = "convox-test-subtitle";
    headerSub.textContent = `Shortcuts: ${shortcutLabel("H")} help • Drag title to move`;
    titleWrap.appendChild(headerSub);

    const headerBtns = document.createElement("div");
    headerBtns.className = "cx-row";
    headerRow.appendChild(headerBtns);

    helpBtn = document.createElement("button");
    helpBtn.className = "cx-btn";
    helpBtn.type = "button";
    helpBtn.textContent = "❓ Help";
    helpBtn.title = `Help (${shortcutLabel("H")})`;
    helpBtn.setAttribute("aria-label", "Help");
    helpBtn.addEventListener("click", speakHelp);
    headerBtns.appendChild(helpBtn);

    minimizeBtn = document.createElement("button");
    minimizeBtn.className = "cx-btn";
    minimizeBtn.type = "button";
    minimizeBtn.textContent = minimized ? "➕ Show" : "➖ Min";
    minimizeBtn.title = `Minimize/Show (${shortcutLabel("M")})`;
    minimizeBtn.setAttribute("aria-pressed", minimized ? "true" : "false");
    headerBtns.appendChild(minimizeBtn);

    // Content
    content = document.createElement("div");
    content.style.marginTop = "10px";
    container.appendChild(content);

    minimizeBtn.addEventListener("click", () => {
      const isHidden = content.style.display === "none";
      setMinimized(!isHidden);
    });

    // Live region for SR announcements
    announceEl = document.createElement("div");
    announceEl.setAttribute("aria-live", "polite");
    announceEl.setAttribute("aria-atomic", "true");
    announceEl.style.position = "absolute";
    announceEl.style.left = "-9999px";
    announceEl.style.top = "-9999px";
    container.appendChild(announceEl);

    // Panel toggles
    const toggles = document.createElement("div");
    toggles.className = "cx-row";
    toggles.style.marginBottom = "8px";
    content.appendChild(toggles);

    collapseLogBtn = document.createElement("button");
    collapseLogBtn.className = "cx-btn cx-btn-secondary";
    collapseLogBtn.type = "button";
    collapseLogBtn.textContent = "📜 Hide Log";
    collapseLogBtn.setAttribute("aria-pressed", "false");
    collapseLogBtn.addEventListener("click", () => {
      const uiSt2 = loadUIState();
      const col = uiSt2.collapsed || {};
      setCollapsed("log", !col.log);
    });
    toggles.appendChild(collapseLogBtn);

    collapseControlsBtn = document.createElement("button");
    collapseControlsBtn.className = "cx-btn cx-btn-secondary";
    collapseControlsBtn.type = "button";
    collapseControlsBtn.textContent = "🎛️ Hide Controls";
    collapseControlsBtn.setAttribute("aria-pressed", "false");
    collapseControlsBtn.addEventListener("click", () => {
      const uiSt2 = loadUIState();
      const col = uiSt2.collapsed || {};
      setCollapsed("controls", !col.controls);
    });
    toggles.appendChild(collapseControlsBtn);

    // Debug toggles row
    const dbgRow = document.createElement("div");
    dbgRow.className = "cx-row";
    dbgRow.style.marginBottom = "8px";
    content.appendChild(dbgRow);

    const debugChip = document.createElement("div");
    debugChip.className = "cx-chip";
    debugChip.textContent = isMac ? "Mac shortcuts" : "Win/Linux shortcuts";
    dbgRow.appendChild(debugChip);

    const lastErrChip = document.createElement("div");
    lastErrChip.className = "cx-chip";
    const uiStErr = loadUIState();
    lastErrChip.textContent = uiStErr.lastError ? "Last error: yes" : "Last error: none";
    lastErrChip.title = uiStErr.lastError ? `${uiStErr.lastErrorAt || ""}\n${uiStErr.lastError}` : "No recent errors";
    dbgRow.appendChild(lastErrChip);

    verboseBtn = document.createElement("button");
    verboseBtn.className = "cx-btn cx-btn-secondary cx-btn-toggle";
    verboseBtn.type = "button";
    verboseBtn.textContent = "🧠 Verbose";
    verboseBtn.title = `Verbose console logs (${shortcutLabel("V")})`;
    verboseBtn.setAttribute("aria-pressed", loadUIState().verbose ? "true" : "false");
    verboseBtn.addEventListener("click", () => {
      const uiSt2 = loadUIState();
      const next = !uiSt2.verbose;
      saveUIState({ verbose: next });
      verboseBtn.setAttribute("aria-pressed", next ? "true" : "false");
      pushConvo("system", `Verbose logging: ${next ? "ON" : "OFF"}`, "info");
    });
    dbgRow.appendChild(verboseBtn);

    const showDebugBtn = document.createElement("button");
    showDebugBtn.className = "cx-btn cx-btn-secondary cx-btn-toggle";
    showDebugBtn.type = "button";
    showDebugBtn.textContent = "🧾 Debug";
    showDebugBtn.title = `Toggle debug lines (${shortcutLabel("G")})`;
    showDebugBtn.setAttribute("aria-pressed", loadUIState().showDebug ? "true" : "false");
    showDebugBtn.addEventListener("click", () => {
      const uiSt2 = loadUIState();
      const next = !uiSt2.showDebug;
      saveUIState({ showDebug: next, showErrorsOnly: false });
      showDebugBtn.setAttribute("aria-pressed", next ? "true" : "false");
      renderLog();
    });
    dbgRow.appendChild(showDebugBtn);

    const errorsOnlyBtn = document.createElement("button");
    errorsOnlyBtn.className = "cx-btn cx-btn-secondary cx-btn-toggle";
    errorsOnlyBtn.type = "button";
    errorsOnlyBtn.textContent = "🚨 Errors";
    errorsOnlyBtn.title = `Errors-only view (${shortcutLabel("E")})`;
    errorsOnlyBtn.setAttribute("aria-pressed", loadUIState().showErrorsOnly ? "true" : "false");
    errorsOnlyBtn.addEventListener("click", () => {
      const uiSt2 = loadUIState();
      const next = !uiSt2.showErrorsOnly;
      saveUIState({ showErrorsOnly: next });
      errorsOnlyBtn.setAttribute("aria-pressed", next ? "true" : "false");
      renderLog();
    });
    dbgRow.appendChild(errorsOnlyBtn);

    // Log wrapper
    logWrap = document.createElement("div");
    logWrap.id = "convox-test-log-wrap";
    content.appendChild(logWrap);

    // Log top bar (search)
    const logTop = document.createElement("div");
    logTop.className = "cx-log-top";
    logWrap.appendChild(logTop);

    searchEl = document.createElement("input");
    searchEl.className = "cx-search";
    searchEl.type = "text";
    searchEl.placeholder = "Search logs (e.g., error, open course, conf 0.9)…";
    searchEl.setAttribute("aria-label", "Search logs");
    searchEl.addEventListener("input", renderLog);
    logTop.appendChild(searchEl);

    // Actual log list container
    const logBox = document.createElement("div");
    logBox.className = "cx-logbox";
    logBox.setAttribute("role", "log");
    logBox.setAttribute("aria-label", "Conversation transcript");
    logBox.setAttribute("aria-live", "off");
    logWrap.appendChild(logBox);

    logListEl = document.createElement("div");
    logBox.appendChild(logListEl);

    // Quick actions row
    const row1 = document.createElement("div");
    row1.className = "cx-row";
    row1.style.marginTop = "8px";
    logWrap.appendChild(row1);

    copyBtn = document.createElement("button");
    copyBtn.className = "cx-btn cx-btn-secondary";
    copyBtn.type = "button";
    copyBtn.textContent = "📋 Copy";
    copyBtn.title = `Copy transcript (${shortcutLabel("C")})`;
    copyBtn.addEventListener("click", copyConversation);
    row1.appendChild(copyBtn);

    clearBtn = document.createElement("button");
    clearBtn.className = "cx-btn cx-btn-secondary";
    clearBtn.type = "button";
    clearBtn.textContent = "🧹 Clear";
    clearBtn.title = `Clear transcript (${shortcutLabel("R")})`;
    clearBtn.addEventListener("click", clearConversation);
    row1.appendChild(clearBtn);

    diagBtn = document.createElement("button");
    diagBtn.className = "cx-btn cx-btn-secondary";
    diagBtn.type = "button";
    diagBtn.textContent = "🩺 Diagnose";
    diagBtn.title = `Diagnose (${shortcutLabel("D")})`;
    diagBtn.addEventListener("click", () => {
      pushConvo("user", "diagnose", "info");
      diagnose();
    });
    row1.appendChild(diagBtn);

    // Controls wrapper
    const controlsWrap = document.createElement("div");
    controlsWrap.id = "convox-test-controls-wrap";
    content.appendChild(controlsWrap);

    const divider = document.createElement("div");
    divider.className = "cx-divider";
    controlsWrap.appendChild(divider);

    inputEl = document.createElement("input");
    inputEl.type = "text";
    inputEl.className = "cx-input";
    inputEl.setAttribute("aria-label", "Command input");
    inputEl.placeholder = "Type a command or use mic 🎤";
    inputEl.title = `Focus command box (${shortcutLabel("F")})`;
    controlsWrap.appendChild(inputEl);

    const controlsRow = document.createElement("div");
    controlsRow.className = "cx-row";
    controlsRow.style.marginTop = "8px";
    controlsWrap.appendChild(controlsRow);

    micBtn = document.createElement("button");
    micBtn.className = "cx-btn cx-btn-secondary";
    micBtn.type = "button";
    micBtn.textContent = "🎤 Listen";
    micBtn.title = `Listen/Stop (${shortcutLabel("L")})`;
    micBtn.setAttribute("aria-pressed", "false");
    controlsRow.appendChild(micBtn);

    stopSpeakBtn = document.createElement("button");
    stopSpeakBtn.className = "cx-btn cx-btn-danger";
    stopSpeakBtn.type = "button";
    stopSpeakBtn.textContent = "🛑 Stop Speaking";
    stopSpeakBtn.title = `Stop speaking (${shortcutLabel("X")})`;
    stopSpeakBtn.addEventListener("click", stopSpeaking);
    controlsRow.appendChild(stopSpeakBtn);

    submitBtn = document.createElement("button");
    submitBtn.className = "cx-btn cx-btn-primary";
    submitBtn.type = "button";
    submitBtn.textContent = "✅ Submit";
    submitBtn.title = `Submit (${shortcutLabel("S")})`;
    controlsRow.appendChild(submitBtn);

    const hints = document.createElement("div");
    hints.className = "cx-muted";
    hints.style.marginTop = "8px";
    hints.textContent = `Tip: Say "summarize" / "due today" / "due this week" / "open course 4901". Press Escape to stop.`;
    controlsWrap.appendChild(hints);

    // Wire minimize/collapse state
    setMinimized(minimized);
    applyCollapsedState();

    // Submit handler
    function submitCommand() {
      const text = (inputEl.value || "").trim();
      if (!text) return;

      if (text.toLowerCase().includes("diagnose")) {
        pushConvo("user", text, "info");
        diagnose();
      } else {
        runUtterance(text);
      }
      inputEl.value = "";
      focusInput();
    }

    submitBtn.addEventListener("click", submitCommand);
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submitCommand();
    });

    // SpeechRecognition
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      logToast("SpeechRecognition not supported in this browser.");
      micBtn.disabled = true;
      micBtn.setAttribute("aria-disabled", "true");
      pushConvo("system", "SpeechRecognition not supported in this browser.", "warn");
    } else {
      recognizer = new SpeechRecognition();
      recognizer.continuous = false;
      recognizer.interimResults = true;
      recognizer.lang = "en-US";

      micBtn.addEventListener("click", () => {
        if (!listening) {
          try {
            recognizer.start();
          } catch {}
        } else {
          stopListening();
        }
      });

      recognizer.addEventListener("start", () => {
        listening = true;
        micBtn.textContent = "🛑 Stop";
        micBtn.setAttribute("aria-pressed", "true");
        inputEl.value = "";
        pushConvo("system", "Listening…", "info");
      });

      recognizer.addEventListener("end", () => {
        listening = false;
        micBtn.textContent = "🎤 Listen";
        micBtn.setAttribute("aria-pressed", "false");
        if (autoSubmitTimer) clearTimeout(autoSubmitTimer);
        autoSubmitTimer = null;
        pushConvo("system", "Stopped listening.", "info");
      });

      recognizer.addEventListener("result", (event) => {
        const transcript = Array.from(event.results)
          .map((r) => r[0].transcript)
          .join("");
        inputEl.value = transcript;

        if (autoSubmitTimer) clearTimeout(autoSubmitTimer);
        autoSubmitTimer = setTimeout(() => submitCommand(), 2000);
      });

      recognizer.addEventListener("speechend", () => stopListening());
    }

    // Global shortcuts (capture phase to avoid Canvas swallowing it)
    function onKeydown(e) {
      // Escape: always stop listening/speaking
      if (e.key === "Escape") {
        stopListening();
        stopSpeaking();
        return;
      }

      // Do not steal keystrokes while typing unless it's an actual shortcut chord
      const inEditable = (el) => {
        if (!el) return false;
        const tag = (el.tagName || "").toLowerCase();
        return tag === "input" || tag === "textarea" || el.isContentEditable;
      };

      const active = document.activeElement;
      if (inEditable(active) && !isShortcutChord(e)) return;

      const handled =
        shortcutMatches(e, "l") ||
        shortcutMatches(e, "s") ||
        shortcutMatches(e, "x") ||
        shortcutMatches(e, "c") ||
        shortcutMatches(e, "r") ||
        shortcutMatches(e, "h") ||
        shortcutMatches(e, "m") ||
        shortcutMatches(e, "d") ||
        shortcutMatches(e, "f") ||
        shortcutMatches(e, "g") ||
        shortcutMatches(e, "e") ||
        shortcutMatches(e, "v");

      if (!handled) return;

      e.preventDefault();
      e.stopPropagation();

      if (shortcutMatches(e, "l")) {
        if (!recognizer) return;
        if (!listening) {
          try {
            recognizer.start();
          } catch {}
        } else stopListening();
        return;
      }
      if (shortcutMatches(e, "s")) return submitCommand();
      if (shortcutMatches(e, "x")) return stopSpeaking();
      if (shortcutMatches(e, "c")) return copyConversation();
      if (shortcutMatches(e, "r")) return clearConversation();
      if (shortcutMatches(e, "h")) return speakHelp();
      if (shortcutMatches(e, "m")) return setMinimized(content.style.display !== "none");
      if (shortcutMatches(e, "d")) {
        pushConvo("user", "diagnose", "info");
        return diagnose();
      }
      if (shortcutMatches(e, "f")) return focusInput();
      if (shortcutMatches(e, "g")) {
        const uiSt2 = loadUIState();
        const next = !uiSt2.showDebug;
        saveUIState({ showDebug: next, showErrorsOnly: false });
        renderLog();
        return;
      }
      if (shortcutMatches(e, "e")) {
        const uiSt2 = loadUIState();
        const next = !uiSt2.showErrorsOnly;
        saveUIState({ showErrorsOnly: next });
        renderLog();
        return;
      }
      if (shortcutMatches(e, "v")) {
        const uiSt2 = loadUIState();
        const next = !uiSt2.verbose;
        saveUIState({ verbose: next });
        verboseBtn?.setAttribute("aria-pressed", next ? "true" : "false");
        pushConvo("system", `Verbose logging: ${next ? "ON" : "OFF"}`, "info");
        return;
      }
    }

    document.addEventListener("keydown", onKeydown, true);
    window.addEventListener("keydown", onKeydown, true);

    // Draggable panel: drag the title area
    enableDrag(headerTitle);
    enableDrag(headerSub);

    // Apply saved position if any
    applyPositionFromState();

    // Add to DOM and render
    document.body.appendChild(container);
    pushConvo("system", `${UI_TITLE} UI ready. Logs persist across pages until you press Clear.`, "info");
    renderLog();
    focusInput();
  }

  // ===========================================================================
  // Boot
  // ===========================================================================
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ensureTestUI, { once: true });
  } else {
    ensureTestUI();
  }
})();
