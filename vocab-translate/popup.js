// popup.js
const $ = (id) => document.getElementById(id);

async function refreshStat() {
  const resp = await chrome.runtime.sendMessage({ type: "getAll" });
  const n = resp && resp.words ? resp.words.length : 0;
  $("stat").textContent = `已记录 ${n} 词`;
}

$("go").addEventListener("click", async () => {
  const word = $("word").value.trim();
  if (!word) return;
  $("out").textContent = "查询中…";
  const r = await chrome.runtime.sendMessage({ type: "translate", word });
  $("out").textContent = `${word}\n${r.translation || "（无结果）"}　[${r.source}]`;
  // 记录
  await chrome.runtime.sendMessage({ type: "record", word, translation: r.translation, sentence: "" });
  refreshStat();
});

$("word").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("go").click();
});

$("openVocab").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL("vocab.html") });
});

$("openQuiz").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL("quiz.html") });
});

$("openSettings").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

$("clearAll").addEventListener("click", async (e) => {
  e.preventDefault();
  if (!confirm("确定清空所有已记录的词汇？此操作不可撤销。")) return;
  await chrome.runtime.sendMessage({ type: "clearAll" });
  refreshStat();
});

refreshStat();
