// content.js — 划词翻译主逻辑
// 1) 页面加载后：扫描全部单词，用免费 Google 批量预翻译缓存，已查词高亮
// 2) 点击单词 → 命中缓存秒回 / 未命中则实时翻译 → 释义在单词上方浮现几秒
// 3) 浮现无背景、继承单词颜色，鼠标移开淡出

(() => {
  "use strict";

  let floatEl = null;
  let hideTimer = null;
  let prefetching = false;

  // ---------- 工具 ----------
  function cleanWord(raw) {
    return (raw || "")
      .toLowerCase()
      .replace(/[^a-z'-]/g, "")
      .replace(/^['-]+|['-]+$/g, "")
      .trim();
  }

  function isWordChar(ch) {
    return /[a-zA-Z'-]/.test(ch);
  }

  // 判断节点是否在代码块内（pre/code/kbd/samp），这些区域不扫描不高亮不翻译
  function isInsideCode(node) {
    let el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    while (el && el !== document.body) {
      const tag = el.tagName;
      if (tag === "PRE" || tag === "CODE" || tag === "KBD" || tag === "SAMP" || tag === "TT") return true;
      el = el.parentElement;
    }
    return false;
  }

  function extractWordAt(textNode, offset) {
    const text = textNode.nodeValue || "";
    if (!text || offset < 0 || offset > text.length) return "";
    let s = Math.min(offset, text.length);
    let start = s;
    while (start > 0 && isWordChar(text[start - 1])) start--;
    let end = s;
    while (end < text.length && isWordChar(text[end])) end++;
    if (end <= start) return "";
    return cleanWord(text.slice(start, end));
  }

  function extractSentenceAround(text, offset) {
    if (!text) return "";
    const end = /[.!?。！？]/;
    let s = Math.min(offset, text.length);
    let start = s;
    while (start > 0 && !end.test(text[start - 1])) start--;
    let e = s;
    while (e < text.length && !end.test(text[e])) e++;
    if (e < text.length && end.test(text[e])) e++;
    return text.slice(start, e).trim();
  }

  // 取点击位置的单词——带空白校验：确认 offset 处确实是字母
  function getWordAt(evt) {
    const el = evt.target;
    if (!el) return null;
    if (el.nodeType !== Node.TEXT_NODE && !["SPAN", "A", "P", "DIV", "LI", "TD", "TH", "H1", "H2", "H3", "H4", "H5", "H6", "B", "I", "EM", "STRONG", "LABEL", "BUTTON", "BLOCKQUOTE", "CAPTION", "SUMMARY"].includes(el.tagName)) {
      return null;
    }
    const x = evt.clientX, y = evt.clientY;
    let textNode = null, offset = 0;

    if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(x, y);
      if (pos && pos.offsetNode && pos.offsetNode.nodeType === Node.TEXT_NODE) {
        textNode = pos.offsetNode;
        offset = pos.offset;
      }
    } else if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      if (r && r.startContainer && r.startContainer.nodeType === Node.TEXT_NODE) {
        textNode = r.startContainer;
        offset = r.startOffset;
      }
    }
    if (!textNode) return null;

    // 空白校验：offset 处和前后必须至少有一个字母
    const t = textNode.nodeValue || "";
    const atChar = t[offset] || "";
    const prevChar = t[offset - 1] || "";
    if (!isWordChar(atChar) && !isWordChar(prevChar)) return null; // 点在空白/标点

    const word = extractWordAt(textNode, offset);
    if (!word || word.length < 1) return null;

    const sent = extractSentenceAround(t, offset) || (el.textContent || "").trim();
    return { word, sentence: sent, textNode, offset };
  }

  // ---------- 浮现释义（无背景，继承颜色） ----------
  function closeFloat() {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    if (floatEl) {
      floatEl.classList.add("vt-fading");
      floatEl.classList.remove("vt-show");
      const toRemove = floatEl;
      setTimeout(() => { if (toRemove.parentNode) toRemove.parentNode.removeChild(toRemove); }, 1300);
      floatEl = null;
    }
  }

  function showFloat(wordEl, word, translation, textNode, offset) {
    closeFloat();
    floatEl = document.createElement("div");
    floatEl.id = "vt-float";

    // 继承被点击词的颜色
    const computed = getComputedStyle(wordEl);
    floatEl.style.color = computed.color;

    // 解析释义：提取音标（如有）和简短释义首行
    let phon = "", meaning = translation;
    const lines = translation.split("\n");
    const phonMatch = translation.match(/音标[:：]\s*([^\n]+)/);
    if (phonMatch) phon = phonMatch[1].trim();
    const meaningLine = lines.find((l) => /^[a-zA-Z]/.test(l) && !l.startsWith("音标"));
    if (meaningLine) meaning = meaningLine;

    floatEl.innerHTML = `<span class="vt-float-text">${escapeHtml(phon ? phon + " " + meaning : meaning)}</span>`;
    document.body.appendChild(floatEl);

    // 精确定位：用点击到的那个词的 Range rect，而不是整个元素
    // 如果已有 textNode+offset，构造临时 Range 取词的精确位置
    let anchorRect = null;
    try {
      if (textNode && offset != null) {
        // 找到 offset 所在的词的起止，包成 Range
        const t = textNode.nodeValue || "";
        let s = Math.min(offset, t.length), e = s;
        while (s > 0 && isWordChar(t[s - 1])) s--;
        while (e < t.length && isWordChar(t[e])) e++;
        // 如果是 .vt-seen span（整词被包住了），直接用它的 rect
        if (textNode.parentElement && textNode.parentElement.classList.contains("vt-seen")) {
          anchorRect = textNode.parentElement.getBoundingClientRect();
        } else if (e > s) {
          const r = document.createRange();
          r.setStart(textNode, s);
          r.setEnd(textNode, e);
          anchorRect = r.getBoundingClientRect();
        }
      }
    } catch (err) {}
    // 回退：用整个元素
    if (!anchorRect) anchorRect = wordEl.getBoundingClientRect();

    const fRect = floatEl.getBoundingClientRect();
    let left = anchorRect.left + anchorRect.width / 2 - fRect.width / 2;
    let top = anchorRect.top - fRect.height - 2;
    if (left < 4) left = 4;
    if (left + fRect.width > window.innerWidth - 4) left = window.innerWidth - fRect.width - 4;
    if (top < 4) top = anchorRect.bottom + 2; // 放不下就放下面
    floatEl.style.left = left + "px";
    floatEl.style.top = top + "px";

    requestAnimationFrame(() => floatEl.classList.add("vt-show"));
    hideTimer = setTimeout(closeFloat, 3000);
  }

  function escapeHtml(s) {
    return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // 安全调用 chrome.runtime——扩展重载/上下文失效时不报错
  function sendMsg(msg) {
    return new Promise((resolve) => {
      try {
        if (!chrome.runtime || !chrome.runtime.sendMessage) return resolve(null);
        chrome.runtime.sendMessage(msg, (resp) => {
          if (chrome.runtime.lastError) return resolve(null); // 上下文失效
          resolve(resp);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  // ---------- 翻译 + 记录 ----------
  async function translateAndShow(evt, word, sentence, clickedEl, textNode, offset) {
    // 先显示 loading（用临时占位，翻译回来后替换）
    showFloat(clickedEl, word, "…", textNode, offset);
    try {
      const resp = await sendMsg({ type: "translate", word, sentence });
      const info = resp || { translation: "无结果", source: "error" };
      showFloat(clickedEl, word, info.translation || "（无释义）", textNode, offset);
      sendMsg({ type: "record", word, translation: info.translation, sentence });
      highlightWordInNode(clickedEl, word);
    } catch (e) {
      showFloat(clickedEl, word, "出错：" + e.message, textNode, offset);
    }
  }

  // ---------- 点击监听 ----------
  document.addEventListener("click", (evt) => {
    if (floatEl && floatEl.contains(evt.target)) return;
    const tag = evt.target.tagName;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(tag) || evt.target.isContentEditable) {
      closeFloat();
      return;
    }
    if (isInsideCode(evt.target)) {
      closeFloat();
      return; // 代码块内点击 → 不翻译、不破坏代码
    }
    // 按钮/链接/表单控件：直接放行，不翻译不拦截，避免干扰点击
    if (evt.target.closest("button") || evt.target.closest("a") || evt.target.closest("input,select,textarea,label")) {
      closeFloat();
      return;
    }

    const result = getWordAt(evt);
    if (!result) {
      closeFloat();
      return; // 点了空白 → 不翻译
    }
    evt.preventDefault();
    translateAndShow(evt, result.word, result.sentence, evt.target, result.textNode, result.offset);
  }, true);
  // 鼠标移开当前 float 区域 → 立即淡出
  document.addEventListener("mousemove", (evt) => {
    if (!floatEl || !hideTimer) return;
    // 如果鼠标离 float 元素和点击词都很远，提前淡出
    const fRect = floatEl.getBoundingClientRect();
    const inFloat = evt.clientX >= fRect.left - 30 && evt.clientX <= fRect.right + 30 &&
                    evt.clientY >= fRect.top - 30 && evt.clientY <= fRect.bottom + 30;
    if (!inFloat) closeFloat();
  }, { passive: true });

  window.addEventListener("scroll", closeFloat, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeFloat(); });

  // ---------- 已查词汇高亮 ----------
  let suppressing = false;

  function highlightSeenWords() {
    if (suppressing) return;
    sendMsg({ type: "getAll" }).then((resp) => {
      if (!resp || !resp.words) return;
      const set = new Set(resp.words.map((w) => w.word.toLowerCase()));
      if (set.size === 0) return;
      suppressing = true;
      try { walkAndHighlight(set); } finally {
        setTimeout(() => { suppressing = false; }, 0);
      }
    });
  }

  function walkAndHighlight(set) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        const tag = p.tagName;
        if (["SCRIPT", "STYLE", "NOSCRIPT", "IFRAME", "TEXTAREA", "INPUT", "SELECT"].includes(tag)) return NodeFilter.FILTER_REJECT;
        if (isInsideCode(node)) return NodeFilter.FILTER_REJECT; // 不高亮代码块
        if (p.classList && p.classList.contains("vt-seen")) return NodeFilter.FILTER_REJECT;
        if (p.closest && (p.closest("#vt-popup") || p.closest("#vt-float"))) return NodeFilter.FILTER_REJECT;
        if (!node.nodeValue || node.nodeValue.trim().length < 2) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const targets = [];
    let n;
    while ((n = walker.nextNode())) targets.push(n);
    for (const node of targets) highlightTextNode(node, set);
  }

  function highlightTextNode(node, set) {
    const text = node.nodeValue;
    const re = /\b([a-zA-Z][a-zA-Z'-]*)\b/g;
    let m, last = 0;
    const frag = document.createDocumentFragment();
    let matched = false;
    while ((m = re.exec(text))) {
      const w = m[1].toLowerCase();
      if (set.has(w)) {
        matched = true;
        if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        const span = document.createElement("span");
        span.className = "vt-seen";
        span.textContent = m[1];
        span.dataset.vtWord = w;
        frag.appendChild(span);
        last = m.index + m[1].length;
      }
    }
    if (!matched) return;
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }

  function highlightWordInNode(el, word) {
    if (!el) return;
    const set = new Set([word.toLowerCase()]);
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!n.nodeValue) return NodeFilter.FILTER_REJECT;
        if (n.parentElement && n.parentElement.classList.contains("vt-seen")) return NodeFilter.FILTER_REJECT;
        if (isInsideCode(n)) return NodeFilter.FILTER_REJECT; // 不高亮代码块
        return n.nodeValue.toLowerCase().includes(word.toLowerCase()) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    let n;
    suppressing = true;
    try { while ((n = walker.nextNode())) highlightTextNode(n, set); } finally {
      setTimeout(() => { suppressing = false; }, 0);
    }
  }

  // ---------- 页面加载批量预翻译（Google 免费，提速点击响应） ----------
  function collectPageWords() {
    const words = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        const tag = p.tagName;
        if (["SCRIPT", "STYLE", "NOSCRIPT", "IFRAME", "TEXTAREA", "INPUT", "SELECT"].includes(tag)) return NodeFilter.FILTER_REJECT;
        if (isInsideCode(node)) return NodeFilter.FILTER_REJECT; // 不预取代码块内的词
        if (!node.nodeValue || node.nodeValue.trim().length < 2) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const re = /\b([a-zA-Z][a-zA-Z'-]{2,})\b/g; // ≥3 字母的词才预取
    let n, m;
    while ((n = walker.nextNode())) {
      re.lastIndex = 0;
      while ((m = re.exec(n.nodeValue))) {
        words.add(m[1].toLowerCase());
      }
    }
    return [...words];
  }

  function prefetchPageWords() {
    if (prefetching) return;
    const words = collectPageWords();
    if (words.length === 0) return;
    prefetching = true;
    // 让 background 批量预翻译（Google 免费，存入 CACHE）
    sendMsg({ type: "prefetch", words }).then(() => { prefetching = false; });
  }

  // ---------- 初始化 ----------
  if (document.readyState === "complete") {
    setTimeout(() => { prefetchPageWords(); highlightSeenWords(); }, 400);
  } else {
    window.addEventListener("load", () => setTimeout(() => { prefetchPageWords(); highlightSeenWords(); }, 400));
  }

  let rescanTimer = null;
  const mo = new MutationObserver(() => {
    if (suppressing) return;
    if (rescanTimer) return;
    rescanTimer = setTimeout(() => {
      rescanTimer = null;
      prefetchPageWords();
      highlightSeenWords();
    }, 1500);
  });
  try { mo.observe(document.body, { childList: true, subtree: true }); } catch (e) {}
})();
