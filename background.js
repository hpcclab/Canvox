// MV3 service worker: resilient fetch bridge + gentle keepalive.

const KEEPALIVE_ALARM = "cvx-keepalive";

// Keep SW waking periodically so content scripts don't hit "context invalidated"
function scheduleKeepalive() {
  try {
    chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 4.9 });
  } catch (_) {}
}
chrome.runtime.onInstalled.addListener(scheduleKeepalive);
chrome.runtime.onStartup.addListener(scheduleKeepalive);
chrome.alarms.onAlarm.addListener(a => {
  if (a.name === KEEPALIVE_ALARM) {
    // Any no-op that wakes the worker is fine; fetch own manifest is tiny.
    fetch(chrome.runtime.getURL("manifest.json")).catch(() => {});
  }
});

// Unified fetch handler used by content scripts.
// Returns either {ok,status,url,contentType,text} OR {ok,status,url,contentType,base64}
async function doFetch(payload) {
  const {
    url,
    method = "GET",
    headers = {},
    responseType = "text"
  } = payload;

  const res = await fetch(url, {
    method,
    headers,
    // include cookies for Canvas / signed redirects
    credentials: "include",
    redirect: "follow",
    cache: "no-store"
  });

  const contentType = res.headers.get("content-type") || "";
  const out = {
    ok: res.ok,
    status: res.status,
    url: res.url,
    contentType
  };

  if (responseType === "arraybuffer") {
    const buf = await res.arrayBuffer();
    // -> base64 for structured clone
    const u8 = new Uint8Array(buf);
    let b64 = "";
    for (let i = 0; i < u8.length; i++) b64 += String.fromCharCode(u8[i]);
    out.base64 = btoa(b64);
  } else {
    out.text = await res.text();
  }
  return out;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === "cvxPing") {
        sendResponse({ ok: true });
        return;
      }
      if (msg?.type === "cvxFetch") {
        const data = await doFetch(msg);
        sendResponse(data);
        return;
      }
      sendResponse({ ok: false, status: 0, error: "unknown message" });
    } catch (e) {
      sendResponse({ ok: false, status: 0, error: String(e && e.message || e) });
    }
  })();
  return true; // async
});
