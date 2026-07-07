// vocab.js — 词汇本页面
const $ = (id) => document.getElementById(id);
let allWords = [];

async function load() {
  const resp = await chrome.runtime.sendMessage({ type: "getAll" });
  allWords = (resp && resp.words) || [];
  const total = allWords.reduce((s, w) => s + (w.count || 0), 0);
  $("sub").textContent = `${allWords.length} words collected · ${total} total lookups`;
  const ss = $("sidebarStat");
  if (ss) ss.innerHTML = `<strong>${allWords.length}</strong> words<br/><strong>${total}</strong> lookups`;
  render();
}

function render() {
  const filter = $("filter").value.trim().toLowerCase();
  const sort = $("sort").value;
  let list = allWords.slice();
  if (filter) {
    list = list.filter(
      (w) =>
        w.word.toLowerCase().includes(filter) ||
        (w.translation || "").toLowerCase().includes(filter)
    );
  }
  if (sort === "count") list.sort((a, b) => (b.count || 0) - (a.count || 0));
  else if (sort === "last") list.sort((a, b) => (b.last || 0) - (a.last || 0));
  else if (sort === "word") list.sort((a, b) => a.word.localeCompare(b.word));

  const maxCount = Math.max(1, ...list.map((w) => w.count || 0));
  const tb = $("tbody");
  tb.innerHTML = "";
  if (list.length === 0) {
    $("empty").style.display = "block";
    $("tbl").style.display = "none";
    return;
  }
  $("empty").style.display = "none";
  $("tbl").style.display = "";

  list.forEach((w, i) => {
    const tr = document.createElement("tr");
    const sentences = (w.sentences || []).map((s) => escapeHtml(s)).join("；");
    const barWidth = Math.round(((w.count || 0) / maxCount) * 60);
    tr.innerHTML = `
      <td style="color:var(--ink-faint);font-family:'DM Mono',monospace;font-size:13px">${i + 1}</td>
      <td class="word-cell">${escapeHtml(w.word)}</td>
      <td>
        <div class="translation-text view">${escapeHtml(w.translation || "—")}</div>
        <textarea class="edit-input edit">${escapeHtml(w.translation || "")}</textarea>
      </td>
      <td style="text-align:center;font-family:'DM Mono',monospace;font-size:14px"><span class="freq-bar" style="width:${barWidth}px"></span>${w.count || 0}</td>
      <td><div class="sentence-text">${sentences || "—"}</div></td>
      <td class="action" style="white-space:nowrap">
        <button class="btn btn-sm btn-ghost edit-btn">Edit</button>
        <button class="btn btn-sm btn-primary save-btn" style="display:none">Save</button>
        <button class="btn btn-sm btn-danger del-btn">×</button>
      </td>`;
    tb.appendChild(tr);

    const editBtn = tr.querySelector(".edit-btn");
    const saveBtn = tr.querySelector(".save-btn");
    const ta = tr.querySelector(".edit");
    editBtn.addEventListener("click", () => {
      tr.classList.add("editing");
      editBtn.style.display = "none";
      saveBtn.style.display = "";
      ta.focus();
    });
    saveBtn.addEventListener("click", async () => {
      const newTrans = ta.value.trim();
      await chrome.runtime.sendMessage({ type: "update", word: w.word, translation: newTrans });
      w.translation = newTrans;
      tr.classList.remove("editing");
      editBtn.style.display = "";
      saveBtn.style.display = "none";
      tr.querySelector(".view").textContent = newTrans || "—";
    });
    tr.querySelector(".del-btn").addEventListener("click", async () => {
      if (!confirm(`删除「${w.word}」？`)) return;
      await chrome.runtime.sendMessage({ type: "deleteWord", word: w.word });
      allWords = allWords.filter((x) => x.word !== w.word);
      render();
    });
  });
}

function escapeHtml(s) {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

$("filter").addEventListener("input", render);
$("sort").addEventListener("change", render);
$("export").addEventListener("click", () => {
  const rows = [["word", "translation", "count", "first", "last", "sentences"]];
  for (const w of allWords) {
    rows.push([
      w.word,
      w.translation || "",
      w.count || 0,
      w.first ? new Date(w.first).toISOString() : "",
      w.last ? new Date(w.last).toISOString() : "",
      (w.sentences || []).join(" | "),
    ]);
  }
  const csv = rows
    .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
    .join("\n");
  const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "vocab-export.csv";
  a.click();
  URL.revokeObjectURL(url);
});
$("openQuiz").addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("quiz.html") }));
$("back").addEventListener("click", (e) => { e.preventDefault(); window.close(); });

load();
