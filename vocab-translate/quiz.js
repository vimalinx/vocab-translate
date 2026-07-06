// quiz.js — 释义选择题
const $ = (id) => document.getElementById(id);
let allWords = [];
let questions = [];
let qIdx = 0;
let correct = 0;
let total = 0;
let mode = "sentence";

function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function escapeHtml(s) {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function loadWords() {
  const resp = await chrome.runtime.sendMessage({ type: "getAll" });
  allWords = ((resp && resp.words) || []).filter(
    (w) => w.translation && w.translation.trim() && w.translation !== "（无释义）"
  );
  $("sub").textContent = `可用词汇 ${allWords.length} 个（需 ≥ 4 个带释义的词）。`;
}

function buildQuestions(count) {
  mode = $("qmode").value;
  // 优先用有句子上下文的词
  let pool = allWords.slice();
  if (mode === "sentence") pool = pool.filter((w) => w.sentences && w.sentences.length);
  pool = shuffle(pool).slice(0, count);

  return pool.map((w) => {
    // 三种模式都用"显示完整原句 + 高亮目标词"的方式
    // prompt 存原句（不挖空），renderQuestion 时高亮目标词
    let prompt = "";
    if (mode === "sentence" || mode === "word") {
      prompt = (w.sentences && w.sentences[0]) ? w.sentences[0] : "";
    } else {
      // reverse: 显示释义，选单词
      prompt = w.translation;
    }
    const distractors = shuffle(allWords.filter((x) => x.word !== w.word)).slice(0, 3);
    return { word: w, prompt, distractors };
  });
}

function renderQuestion() {
  if (qIdx >= questions.length) return finish();
  const q = questions[qIdx];
  const card = document.createElement("div");
  card.className = "qcard";
  card.innerHTML = `<div class="qnum">Question ${qIdx + 1} of ${questions.length}</div>`;

  if (mode === "sentence") {
    // 显示完整原句，高亮目标词
    card.innerHTML += `<div class="question-text">${renderSentenceWithHighlight(q.prompt, q.word.word)}</div>`;
  } else if (mode === "word") {
    // 没有原句时只显示单词
    card.innerHTML += `<div class="question-text" style="text-align:center">${renderSentenceWithHighlight(q.prompt, q.word.word)}</div>`;
  } else {
    // reverse: 显示释义选单词
    card.innerHTML += `<div class="question-text">Which word matches this meaning?<br><span style="font-size:18px;color:var(--ink-soft);font-style:italic">${escapeHtml(q.word.translation)}</span></div>`;
  }

  const optsDiv = document.createElement("div");
  optsDiv.className = "options";

  let correctText, wrongTexts;
  if (mode === "reverse") {
    correctText = q.word.word;
    wrongTexts = q.distractors.map((d) => d.word);
  } else {
    correctText = q.word.translation;
    wrongTexts = q.distractors.map((d) => d.translation || "—");
  }
  const seen = new Set([correctText]);
  wrongTexts = wrongTexts.filter((t) => { if (seen.has(t)) return false; seen.add(t); return true; });
  const options = shuffle([correctText, ...wrongTexts]);

  options.forEach((opt) => {
    const b = document.createElement("button");
    b.className = "quiz-opt";
    b.textContent = opt;
    b.addEventListener("click", () => {
      [...optsDiv.children].forEach((x) => (x.disabled = true));
      const isRight = opt === correctText;
      total++;
      if (isRight) { correct++; b.classList.add("correct"); }
      else { b.classList.add("wrong"); [...optsDiv.children].forEach((x) => { if (x.textContent === correctText) x.classList.add("correct"); }); }
      $("score").textContent = `${correct} / ${total}`;
      const ex = document.createElement("div");
      ex.className = "explain";
      ex.style.display = "block";
      ex.innerHTML = `<span class="word">${escapeHtml(q.word.word)}</span>：${escapeHtml(q.word.translation)} <span class="freq">freq ${q.word.count || 0}</span>`;
      card.appendChild(ex);
      const next = document.createElement("button");
      next.className = "btn btn-primary";
      next.style.marginTop = "14px";
      next.textContent = qIdx + 1 < questions.length ? "Next →" : "See results";
      next.addEventListener("click", () => { qIdx++; renderQuestion(); });
      card.appendChild(next);
    });
    optsDiv.appendChild(b);
  });
  card.appendChild(optsDiv);
  $("questions").innerHTML = "";
  $("questions").appendChild(card);
}

// 显示完整句子，把目标词高亮（不挖空）
function renderSentenceWithHighlight(sentence, word) {
  if (!sentence) return `<span style="font-size:20px;font-family:'Instrument Serif',serif">${escapeHtml(word)}</span>`;
  const escaped = escapeHtml(sentence);
  const re = new RegExp("\\b(" + word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")\\b", "gi");
  return escaped.replace(re, '<span class="blank">$1</span>');
}
function finish() {
  $("quiz").style.display = "none";
  $("result").style.display = "block";
  const pct = total ? Math.round((correct / total) * 100) : 0;
  $("finalScore").textContent = pct + "%";
  let text = "";
  if (pct >= 90) text = "Excellent — you've mastered these words.";
  else if (pct >= 70) text = "Good work — keep practicing.";
  else if (pct >= 50) text = "Getting there — review and retry.";
  else text = "Keep studying — revisit the lexicon.";
  $("finalText").textContent = `${correct} / ${total} correct. ${text}`;
}

$("start").addEventListener("click", () => {
  if (allWords.length < 4) {
    alert("需要至少 4 个带释义的词才能生成选择题。");
    return;
  }
  const count = Math.min(parseInt($("qcount").value, 10), allWords.length);
  questions = buildQuestions(count);
  if (questions.length === 0) {
    alert("当前模式没有可用的题目。原句填空模式需要单词带有来源句子。");
    return;
  }
  qIdx = 0;
  correct = 0;
  total = 0;
  $("setup").style.display = "none";
  $("result").style.display = "none";
  $("quiz").style.display = "block";
  $("score").textContent = "0 / 0";
  renderQuestion();
});

$("restart").addEventListener("click", () => {
  $("quiz").style.display = "none";
  $("setup").style.display = "block";
  $("result").style.display = "none";
});
$("again").addEventListener("click", (e) => {
  e.preventDefault();
  $("restart").click();
});

loadWords();
