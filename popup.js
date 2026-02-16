const DEFAULT_THRESHOLD_MIN = 3;

function storageGet(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}
function storageSet(obj) {
  return new Promise(resolve => chrome.storage.local.set(obj, resolve));
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function countDataRows(csvText) {
  const lines = csvText.trimEnd().split("\n");
  return Math.max(0, lines.length - 1);
}

(async function init() {
  const el = {
    thresholdMin: document.getElementById("thresholdMin"),
    save: document.getElementById("save"),
    copy: document.getElementById("copy"),
    download: document.getElementById("download"),
    clear: document.getElementById("clear"),
    csv: document.getElementById("csv"),
    count: document.getElementById("count"),
  };

  const { thresholdMin, csvText } = await storageGet(["thresholdMin", "csvText"]);
  el.thresholdMin.value = (typeof thresholdMin === "number" ? thresholdMin : DEFAULT_THRESHOLD_MIN);

  const header = "netid,duration,detected_at,page_url\n";
  const csv = (csvText && csvText.trim().length) ? csvText : header;

  el.csv.value = csv;
  el.count.textContent = `${countDataRows(csv)} rows`;

  el.save.onclick = async () => {
    const v = parseFloat(el.thresholdMin.value);
    const next = Number.isFinite(v) ? v : DEFAULT_THRESHOLD_MIN;
    await storageSet({ thresholdMin: next });
    el.save.textContent = "Saved";
    setTimeout(() => (el.save.textContent = "Save"), 900);
  };

  el.copy.onclick = async () => {
    await navigator.clipboard.writeText(el.csv.value);
    el.copy.textContent = "Copied";
    setTimeout(() => (el.copy.textContent = "Copy CSV"), 900);
  };

  el.download.onclick = async () => {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    downloadText(`duration_flags_${stamp}.csv`, el.csv.value);
  };

  el.clear.onclick = async () => {
    const header = "netid,duration,detected_at,page_url\n";
    await storageSet({ csvText: header, seenKeys: {} });
    el.csv.value = header;
    el.count.textContent = "0 rows";
  };
})();
