// background.js — Service Worker
// 翻译缓存 + 存储操作 + 消息中枢
import { vimalinxLogin, vimalinxLogout, vmGetStatus, translateByVimalinx } from "./vimalinx.js";


const CACHE = new Map();
const MAX_CACHE = 500;

// 读取引擎配置
async function getConfig() {
  const cfg = await chrome.storage.local.get({
    "cfg:engine": "deepseek",
    "cfg:apikey": "",
    "cfg:model": "deepseek-v4-flash",
  });
  return {
    engine: cfg["cfg:engine"] || "deepseek",
    apikey: cfg["cfg:apikey"] || "",
    model: cfg["cfg:model"] || "deepseek-v4-flash",
  };
}

// 主翻译入口：按引擎分发
async function translateWord(word) {
  word = word.trim().toLowerCase();
  if (!word) return { translation: "", source: "empty" };

  // 1) 内存缓存
  if (CACHE.has(word)) return CACHE.get(word);
  // 2) 已存词汇（离线命中）
  const stored = await chrome.storage.local.get("v:" + word);
  if (stored["v:" + word]) {
    const r = { translation: stored["v:" + word].translation, source: "local" };
    CACHE.set(word, r);
    return r;
  }

  // 3) 联网翻译：Vimalinx（统一账号）> DeepSeek（直连 key）> Google（回退）
  const cfg = await getConfig();
  const vmStatus = await vmGetStatus();
  let result = null;

  // 优先：Vimalinx 统一账号（已登录走 api.vimalinx.com/v1）
  if (vmStatus.loggedIn) {
    result = await translateByVimalinx(word).catch((e) => {
      console.warn("Vimalinx 失败，尝试 DeepSeek/Google:", e.message);
      return null;
    });
  }
  // 回退 1：DeepSeek 直连 key（设置页填写）
  if (!result && cfg.engine === "deepseek" && cfg.apikey) {
    result = await translateByDeepSeek(word, cfg).catch((e) => {
      console.warn("DeepSeek 失败，回退 Google:", e.message);
      return null;
    });
  }
  // 回退 2：Google Translate（免 key）
  if (!result) {
    result = await translateByGoogle(word);
  }

  if (CACHE.size > MAX_CACHE) CACHE.clear();
  CACHE.set(word, result);
  return result;
}

// DeepSeek：用 LLM 生成词典级释义
async function translateByDeepSeek(word, cfg) {
  const prompt =
    `你是英汉词典。请给出英文单词 "${word}" 的中文释义，按下面的格式回答，不要任何多余内容：\n` +
    `音标：[IPA]\n` +
    `词性 释义1；释义2\n` +
    `词性 释义1；释义2\n` +
    `\n` +
    `示例：\n` +
    `音标：/ˌserənˈdɪpəti/\n` +
    `名词 意外发现美好事物的能力；机缘巧合\n` +
    `\n` +
    `现在请解释 "${word}"：`;

  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + cfg.apikey,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 300,
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`DeepSeek HTTP ${res.status}: ${txt.slice(0, 100)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("DeepSeek 返回空");
  return { translation: content, source: "DeepSeek" };
}

// Google Translate 公开端点（免 key 回退）
async function translateByGoogle(word) {
  try {
    const url =
      "https://translate.googleapis.com/translate_a/single?client=gtx" +
      "&sl=en&tl=zh-CN&dt=t&dt=bd&q=" + encodeURIComponent(word);
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    let translation = "";
    if (Array.isArray(data) && Array.isArray(data[0])) {
      translation = data[0].map((s) => (s && s[0] ? s[0] : "")).join("").trim();
    }
    let defs = [];
    if (Array.isArray(data[1])) {
      for (const g of data[1]) {
        if (!g || !Array.isArray(g[2])) continue;
        const pos = g[0] || "";
        for (const it of g[2]) if (it && it[0]) defs.push(pos ? `${pos} ${it[0]}` : it[0]);
      }
    }
    if (defs.length && defs.join("；").length < 200) translation = translation || defs.join("；");
    return { translation: translation || "（无释义）", source: "Google" };
  } catch (e) {
    return { translation: "翻译失败：" + e.message, source: "error" };
  }
}

// 批量预翻译：页面所有词用 Google 免费翻译预填 CACHE，点击时秒回
// 已在缓存/已存的词跳过；并发限制 6，避免被 Google 限流
async function prefetchWords(words) {
  const todo = [];
  for (const w of words) {
    const word = w.trim().toLowerCase();
    if (!word || word.length < 3) continue;
    if (CACHE.has(word)) continue;
    const stored = await chrome.storage.local.get("v:" + word);
    if (stored["v:" + word]) {
      CACHE.set(word, { translation: stored["v:" + word].translation, source: "local" });
      continue;
    }
    todo.push(word);
  }
  if (todo.length === 0) return 0;

  const CONCURRENCY = 6;
  let done = 0;
  let idx = 0;
  async function worker() {
    while (idx < todo.length) {
      const word = todo[idx++];
      const r = await translateByGoogle(word);
      if (r && r.translation && r.source !== "error") {
        CACHE.set(word, r);
        done++;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, () => worker()));
  return done;
}

// 保存/更新词汇
async function recordWord(word, translation, sentence) {
  word = word.trim().toLowerCase();
  if (!word) return;
  const key = "v:" + word;
  const data = await chrome.storage.local.get(key);
  const prev = data[key] || {
    word,
    translation,
    count: 0,
    first: Date.now(),
    sentences: [],
  };
  prev.count = (prev.count || 0) + 1;
  prev.last = Date.now();
  prev.translation = translation || prev.translation;
  if (sentence && sentence.trim()) {
    prev.sentences = prev.sentences || [];
    if (!prev.sentences.includes(sentence.trim())) {
      prev.sentences.push(sentence.trim());
      if (prev.sentences.length > 20) prev.sentences.shift();
    }
  }
  await chrome.storage.local.set({ [key]: prev });

  // 更新缓存里的 translation
  CACHE.set(word, { translation: prev.translation, source: "local" });
}

// 批量获取已查词汇
async function getAllWords() {
  const all = await chrome.storage.local.get(null);
  const words = [];
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith("v:") && v && v.word) words.push(v);
  }
  words.sort((a, b) => (b.count || 0) - (a.count || 0));
  return words;
}

// 导出 / 清空
async function clearAll() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith("v:"));
  await chrome.storage.local.remove(keys);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "translate") {
        const r = await translateWord(msg.word);
        sendResponse(r);
      } else if (msg.type === "record") {
        await recordWord(msg.word, msg.translation, msg.sentence);
        sendResponse({ ok: true });
      } else if (msg.type === "recordOnly") {
        await recordWord(msg.word, "", msg.sentence);
        sendResponse({ ok: true });
      } else if (msg.type === "getAll") {
        sendResponse({ words: await getAllWords() });
      } else if (msg.type === "clearAll") {
        await clearAll();
        sendResponse({ ok: true });
      } else if (msg.type === "update") {
        // 更新某条词的释义
        const key = "v:" + msg.word.toLowerCase();
        const data = await chrome.storage.local.get(key);
        const prev = data[key];
        if (prev) {
          prev.translation = msg.translation;
          prev.last = Date.now();
          await chrome.storage.local.set({ [key]: prev });
          CACHE.set(msg.word.toLowerCase(), { translation: msg.translation, source: "local" });
        }
        sendResponse({ ok: true });
      } else if (msg.type === "deleteWord") {
        await chrome.storage.local.remove("v:" + msg.word.toLowerCase());
        CACHE.delete(msg.word.toLowerCase());
        sendResponse({ ok: true });
      } else if (msg.type === "vm:login") {
        const data = await vimalinxLogin();
        sendResponse({ ok: true, data });
      } else if (msg.type === "vm:logout") {
        await vimalinxLogout();
        sendResponse({ ok: true });
      } else if (msg.type === "vm:status") {
        const s = await vmGetStatus();
        sendResponse(s);
      } else if (msg.type === "prefetch") {
        // 页面加载批量预翻译：Google 免费，存入内存 CACHE，点击时秒回
        const count = await prefetchWords(msg.words || []);
        sendResponse({ ok: true, prefetched: count });
      } else {
        sendResponse({ error: "unknown" });
      }
    } catch (e) {
      sendResponse({ error: String(e) });
    }
  })();
  return true; // 异步
});
