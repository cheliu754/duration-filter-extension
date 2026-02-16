(() => {
  const DEFAULT_THRESHOLD_MIN = 3;

  function storageGet(keys) {
    return new Promise(resolve => chrome.storage.local.get(keys, resolve));
  }
  function storageSet(obj) {
    return new Promise(resolve => chrome.storage.local.set(obj, resolve));
  }

  // ---- Duration parsing ----
  function parseDurationToSeconds(text) {
    // Supports: "3 h 1 min 23 s", "1 min 53 s", "2 min", "59 s", etc.
    if (!text) return null;
    const t = text.toLowerCase().trim();

    let hours = 0;
    let minutes = 0;
    let seconds = 0;

    const hourMatch = t.match(/(\d+)\s*h/);
    const minMatch = t.match(/(\d+)\s*min/);
    const secMatch = t.match(/(\d+)\s*s/);

    if (hourMatch) hours = parseInt(hourMatch[1], 10);
    if (minMatch) minutes = parseInt(minMatch[1], 10);
    if (secMatch) seconds = parseInt(secMatch[1], 10);

    if (!hourMatch && !minMatch && !secMatch) return null;
    return hours * 3600 + minutes * 60 + seconds;
  }

  // ---- DOM lookup helpers ----
  function findDurationValueDivWithin(cardEl) {
    // Looks for:
    // <div class="d-flex flex-wrap">
    //   <div class="pe-1">Duration:</div>
    //   <div>1 min 53 s</div>
    // </div>
    const rows = cardEl.querySelectorAll(".d-flex.flex-wrap");
    for (const row of rows) {
      const label = row.querySelector(".pe-1");
      if (!label) continue;
      if (label.textContent.trim().toLowerCase() === "duration:") {
        const divs = Array.from(row.querySelectorAll("div"));
        const valueDiv = divs.find(d => d !== label);
        return valueDiv || null;
      }
    }
    return null;
  }

  function findNearestStudentInfo(cardEl) {
    // Best-effort: search upwards/previous siblings for a "Student details" block:
    // <details ...><summary><h3>Student details</h3></summary> ... <div class="d-flex flex-wrap mt-2"> ...
    let node = cardEl;
    for (let i = 0; i < 140 && node; i++) {
      const h3 = node.querySelector?.("details summary h3");
      if (h3 && h3.textContent.trim().toLowerCase() === "student details") {
        const container = node.querySelector(".d-flex.flex-wrap.mt-2");
        const parts = container
          ? Array.from(container.querySelectorAll("div")).map(d => d.textContent.trim()).filter(Boolean)
          : [];
        const email = parts.find(x => x.includes("@")) || "Unknown";
        const name = parts[0] || "Unknown";
        return { name, email };
      }
      if (node.previousElementSibling) node = node.previousElementSibling;
      else node = node.parentElement;
    }
    return { name: "Unknown", email: "Unknown" };
  }

  function netidFromEmail(email) {
    if (!email || !email.includes("@")) return "unknown";
    const n = email.split("@")[0].trim();
    return n || "unknown";
  }

  function escapeHtml(str) {
    return (str || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  // ---- Badge ----
  function upsertBadge() {
    let badge = document.querySelector(".dcd-badge");
    if (!badge) {
      badge = document.createElement("div");
      badge.className = "dcd-badge";
      document.body.appendChild(badge);
    }
    return badge;
  }

  // ---- CSV accumulation (deduplicated) ----
  async function ensureStorageInitialized() {
    const { csvText, seenKeys } = await storageGet(["csvText", "seenKeys"]);
    const header = "netid,duration,detected_at,page_url\n";
    const init = {};
    if (!csvText || !csvText.length) init.csvText = header;
    if (!seenKeys || typeof seenKeys !== "object") init.seenKeys = {};
    if (Object.keys(init).length) await storageSet(init);
  }

  async function appendCsvRowIfNew({ netid, durationText, pageUrl }) {
    const { csvText, seenKeys } = await storageGet(["csvText", "seenKeys"]);
    const seen = (seenKeys && typeof seenKeys === "object") ? seenKeys : {};

    // A stable key to avoid duplicates across repeated re-scans while you click Next/Grade
    const key = `${netid}||${durationText}||${pageUrl}`;
    if (seen[key]) return false;

    const detectedAt = new Date().toISOString();
    const header = "netid,duration,detected_at,page_url\n";
    const base = (csvText && csvText.length) ? csvText : header;

    const csvField = (v) => {
      const s = String(v ?? "");
      if (/[",\n]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
      return s;
    };

    const row =
      `${csvField(netid)},` +
      `${csvField(`duration: ${durationText}`)},` +
      `${csvField(detectedAt)},` +
      `${csvField(pageUrl)}\n`;

    seen[key] = true;
    await storageSet({ csvText: base + row, seenKeys: seen });
    return true;
  }

  // ---- Main scan ----
  async function scanAndFlag() {
    const { thresholdMin } = await storageGet(["thresholdMin"]);
    const thresholdMinutes =
      (typeof thresholdMin === "number" && Number.isFinite(thresholdMin))
        ? thresholdMin
        : DEFAULT_THRESHOLD_MIN;

    const thresholdSeconds = Math.max(0, thresholdMinutes * 60);

    // Reset highlight (idempotent)
    document.querySelectorAll(".dcd-flagged").forEach(el => el.classList.remove("dcd-flagged"));

    const cards = Array.from(document.querySelectorAll(".list-group-item.py-3"));
    const flagged = [];

    for (const card of cards) {
      // Only check duration within "Variant" sections, skip "Assessment instance" etc.
      const sectionHeader = card.querySelector("h3");
      if (!sectionHeader || sectionHeader.textContent.trim() !== "Variant") continue;

      const durationValueDiv = findDurationValueDivWithin(card);
      if (!durationValueDiv) continue;

      const durationText = durationValueDiv.textContent.trim();
      const seconds = parseDurationToSeconds(durationText);
      if (seconds == null) continue;

      // Rule: duration < threshold AND duration > 0
      if (seconds > 0 && seconds < thresholdSeconds) {
        card.classList.add("dcd-flagged");

        const { email } = findNearestStudentInfo(card);
        const netid = netidFromEmail(email);

        flagged.push({ netid, email, durationText, seconds });

        // Accumulate CSV (deduplicated)
        appendCsvRowIfNew({
          netid,
          durationText,
          pageUrl: location.href
        }).catch(() => {});
      }
    }

    // Update badge UI (English)
    const badge = upsertBadge();
    const preview = flagged.slice(0, 6).map(x => `• ${x.netid} — ${x.durationText}`).join("\n");

    badge.innerHTML = `
      <div><b>Flagged (&lt; ${escapeHtml(String(thresholdMinutes))} min, excluding 0):</b> ${flagged.length}</div>
      ${flagged.length ? `<pre><code>${escapeHtml(preview)}</code></pre>` : ""}
      <div style="margin-top:8px;opacity:.78;">Open the extension popup to view/export the CSV.</div>
    `;

    // Console output (English)
    if (flagged.length) {
      console.group(`[Duration Cheat Detector] thresholdMin=${thresholdMinutes}, flagged=${flagged.length}`);
      console.table(flagged.map(x => ({
        netid: x.netid,
        email: x.email,
        duration: x.durationText,
        seconds: x.seconds
      })));
      console.groupEnd();
    }
  }

  // ---- SPA robustness: observe DOM + hook history ----
  function hookHistoryForSpa() {
    const _push = history.pushState;
    const _replace = history.replaceState;

    history.pushState = function(...args) {
      _push.apply(this, args);
      window.dispatchEvent(new Event("dcd:navigation"));
    };

    history.replaceState = function(...args) {
      _replace.apply(this, args);
      window.dispatchEvent(new Event("dcd:navigation"));
    };

    window.addEventListener("popstate", () => window.dispatchEvent(new Event("dcd:navigation")));
    window.addEventListener("dcd:navigation", () => scanAndFlag());
  }

  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      scanAndFlag();
    });
  });

  (async function start() {
    await ensureStorageInitialized();
    hookHistoryForSpa();
    scanAndFlag();

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
  })();
})();
