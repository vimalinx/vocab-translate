// background.js — Service Worker
// 翻译缓存 + 存储操作 + 消息中枢 + Vimalinx 账号集成（内联，非 module）

const CACHE = new Map();
const MAX_CACHE = 500;

// ========== Vimalinx 统一账号集成（从 vimalinx.js 内联）==========
const VIMALINX = {
  issuer: "https://auth.vimalinx.com/oidc",
  authEndpoint: "https://auth.vimalinx.com/oidc/auth",
  tokenEndpoint: "https://auth.vimalinx.com/oidc/token",
  bootstrapUrl: "https://api.vimalinx.com/api/vimalinx/client/bootstrap",
  openaiBaseUrl: "https://api.vimalinx.com/v1",
  statusUrl: "https://api.vimalinx.com/api/status",
  defaultClientId: "",
  scope: "openid profile email offline_access",
};
const VK = {
  clientId: "vm:clientId", apikey: "vm:apikey", baseUrl: "vm:baseUrl",
  quota: "vm:quota", models: "vm:models", user: "vm:user",
  refreshToken: "vm:refreshToken", group: "vm:group", loggedIn: "vm:loggedIn",
};

function randomBytes(len) { const arr = new Uint8Array(len); crypto.getRandomValues(arr); return arr; }
function base64url(bytes) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
async function sha256(input) { const data = new TextEncoder().encode(input); const hash = await crypto.subtle.digest("SHA-256", data); return new Uint8Array(hash); }
async function generatePkce() { const verifier = base64url(randomBytes(32)); const challenge = base64url(await sha256(verifier)); return { verifier, challenge }; }
function generateState() { return base64url(randomBytes(16)); }

async function vmGetConfig() {
  const cfg = await chrome.storage.local.get({ "vm:clientId": VIMALINX.defaultClientId });
  return { clientId: cfg["vm:clientId"] || VIMALINX.defaultClientId };
}

async function vimalinxLogin() {
  const { clientId } = await vmGetConfig();
  if (!clientId) throw new Error("未配置 Logto 公共客户端 ID。");
  const redirectUri = chrome.identity.getRedirectURL();
  const pkce = await generatePkce();
  const state = generateState();
  await chrome.storage.local.set({ "vm:pkceVerifier": pkce.verifier, "vm:pkceState": state, "vm:redirectUri": redirectUri });
  const authUrl = VIMALINX.authEndpoint + "?response_type=code&client_id=" + encodeURIComponent(clientId) + "&redirect_uri=" + encodeURIComponent(redirectUri) + "&scope=" + encodeURIComponent(VIMALINX.scope) + "&state=" + encodeURIComponent(state) + "&code_challenge=" + encodeURIComponent(pkce.challenge) + "&code_challenge_method=S256";
  const callbackUrl = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
  if (!callbackUrl) throw new Error("登录被取消");
  const url = new URL(callbackUrl);
  const code = url.searchParams.get("code");
  const st = url.searchParams.get("state");
  if (url.searchParams.get("error")) throw new Error("Logto 登录失败：" + (url.searchParams.get("error_description") || url.searchParams.get("error")));
  if (!code) throw new Error("回调缺少 authorization code");
  const stored = await chrome.storage.local.get(["vm:pkceState", "vm:pkceVerifier", "vm:redirectUri"]);
  if (st !== stored["vm:pkceState"]) throw new Error("state 校验失败");
  const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: stored["vm:redirectUri"], client_id: (await vmGetConfig()).clientId, code_verifier: stored["vm:pkceVerifier"] });
  const tokenRes = await fetch(VIMALINX.tokenEndpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  if (!tokenRes.ok) throw new Error("Token endpoint 失败：HTTP " + tokenRes.status);
  const tokens = await tokenRes.json();
  await chrome.storage.local.remove(["vm:pkceVerifier", "vm:pkceState", "vm:redirectUri"]);
  const jwt = tokens.id_token || tokens.access_token;
  const bsRes = await fetch(VIMALINX.bootstrapUrl, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + jwt }, body: JSON.stringify({ group: "default", token_name: "vocab-translate-ext" }) });
  if (!bsRes.ok) throw new Error("Bootstrap 失败：HTTP " + bsRes.status);
  const bsJson = await bsRes.json();
  if (!bsJson.ok || !bsJson.data) throw new Error("Bootstrap 返回格式异常");
  const d = bsJson.data;
  await chrome.storage.local.set({
    [VK.apikey]: d.api_key, [VK.baseUrl]: d.base_url || VIMALINX.openaiBaseUrl,
    [VK.quota]: { total: d.quota, remain: d.token_remain_quota ?? d.quota, perUnit: d.quota_per_unit, displayType: d.quota_display_type, price: d.price },
    [VK.models]: d.models || [], [VK.group]: d.group || "default",
    [VK.user]: { id: d.user_id, username: d.username, displayName: d.display_name, email: d.email, avatarUrl: d.avatar_url || d.avatarUrl },
    [VK.loggedIn]: true,
  });
  return d;
}

async function vmGetStatus() {
  const s = await chrome.storage.local.get([VK.loggedIn, VK.apikey, VK.user, VK.quota, VK.models, VK.group]);
  return { loggedIn: !!s[VK.loggedIn] && !!s[VK.apikey], user: s[VK.user] || null, quota: s[VK.quota] || null, models: s[VK.models] || [], group: s[VK.group] || "default" };
}

async function vimalinxLogout() {
  await chrome.storage.local.remove([VK.apikey, VK.baseUrl, VK.quota, VK.models, VK.user, VK.group, VK.loggedIn, VK.refreshToken]);
}

async function translateByVimalinx(word, sentence) {
  const stored = await chrome.storage.local.get([VK.apikey, VK.baseUrl, VK.models]);
  if (!stored[VK.apikey]) return { translation: "未登录 Vimalinx 账号。", source: "error" };
  const baseUrl = stored[VK.baseUrl] || VIMALINX.openaiBaseUrl;
  const model = "deepseek-v4-flash";
  let prompt;
  if (sentence) {
    prompt = `你是英汉词典。在下面这个句子的语境中，给出单词 "${word}" 的准确中文释义。\n只给出在该语境下成立的意思，不要罗列所有义项。格式如下，不要多余内容：\n音标：[IPA]\n词性 该语境下的释义\n\n原句：${sentence}\n单词：${word}\n\n示例——原句 "Gene expression was upregulated." 单词 "expression"：\n音标：/ɪkˈspreʃn/\n名词 （基因）表达`;
  } else {
    prompt = `你是英汉词典。请给出英文单词 "${word}" 的中文释义，按下面的格式回答，不要任何多余内容：\n音标：[IPA]\n词性 释义1；释义2\n\n现在请解释 "${word}"：`;
  }
  const res = await fetch(baseUrl + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + stored[VK.apikey] },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0, max_tokens: 400 }),
  });
  if (res.status === 401) return { translation: "AI 凭据已失效，请重新登录 Vimalinx。", source: "error-auth" };
  if (res.status === 429 || res.status === 402) return { translation: "AI 额度不足。", source: "error-quota" };
  if (!res.ok) { const txt = await res.text().catch(() => ""); return { translation: `翻译失败：HTTP ${res.status}`, source: "error" }; }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content?.trim();
  if (!content) return { translation: "AI 返回空内容。", source: "error" };
  return { translation: content, source: "Vimalinx" };
}
// ========== Vimalinx 集成结束 ==========

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
async function translateWord(word, sentence) {
  word = word.trim().toLowerCase();
  if (!word) return { translation: "", source: "empty" };
  sentence = (sentence || "").trim();

  // 1) 内存缓存：只在无上下文时缓存（同一词在不同语境释义可能不同）
  if (!sentence && CACHE.has(word)) return CACHE.get(word);
  // 2) 已存词汇（离线命中）——仅无上下文时
  if (!sentence) {
    const stored = await chrome.storage.local.get("v:" + word);
    if (stored["v:" + word]) {
      const r = { translation: stored["v:" + word].translation, source: "local" };
      CACHE.set(word, r);
      return r;
    }
  }

  // 3) 联网翻译：Vimalinx（统一账号）> DeepSeek（直连 key）> Google（回退）
  const cfg = await getConfig();
  const vmStatus = await vmGetStatus();
  console.log("[VT] engines: vm=" + vmStatus.loggedIn, "ds=" + (cfg.engine === "deepseek" && !!cfg.apikey), "google=always");
  let result = null;

  if (vmStatus.loggedIn) {
    result = await translateByVimalinx(word, sentence).catch((e) => {
      console.warn("Vimalinx 失败，尝试 DeepSeek/Google:", e.message);
      return null;
    });
  }
  if (!result && cfg.engine === "deepseek" && cfg.apikey) {
    result = await translateByDeepSeek(word, cfg, sentence).catch((e) => {
      console.warn("DeepSeek 失败，回退 Google:", e.message);
      return null;
    });
  }
  if (!result) {
    result = await translateByGoogle(word, sentence);
  }

  if (CACHE.size > MAX_CACHE) CACHE.clear();
  if (!sentence) CACHE.set(word, result); // 仅缓存无上下文结果
  return result;
}

// DeepSeek：用 LLM 在语境中生成释义
async function translateByDeepSeek(word, cfg, sentence) {
  // 带上下文：让 LLM 根据原句判断词义
  let prompt;
  if (sentence) {
    prompt =
      `你是英汉词典。在下面这个句子的语境中，给出单词 "${word}" 的准确中文释义。\n` +
      `只给出在该语境下成立的意思，不要罗列所有义项。格式如下，不要多余内容：\n` +
      `音标：[IPA]\n` +
      `词性 该语境下的释义\n` +
      `\n` +
      `原句：${sentence}\n` +
      `单词：${word}\n` +
      `\n` +
      `示例——原句 "Gene expression was upregulated." 单词 "expression"：\n` +
      `音标：/ɪkˈspreʃn/\n` +
      `名词 （基因）表达\n`;
  } else {
    prompt =
      `你是英汉词典。请给出英文单词 "${word}" 的中文释义，按下面的格式回答，不要任何多余内容：\n` +
      `音标：[IPA]\n` +
      `词性 释义1；释义2\n` +
      `\n` +
      `现在请解释 "${word}"：`;
  }

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

// Google Translate：有语境时整句翻译优先（自动消歧），无语境时查词典义
async function translateByGoogle(word, sentence) {
  try {
    // 1) 单词词典义（始终查，作为基础释义）
    const url =
      "https://translate.googleapis.com/translate_a/single?client=gtx" +
      "&sl=en&tl=zh-CN&dt=t&dt=bd&q=" + encodeURIComponent(word);
    console.log("[VT] Google fetch start:", word);
    const res = await fetch(url, { method: "GET" });
    console.log("[VT] Google fetch done:", res.status);
    if (!res.ok) throw new Error("HTTP " + res.status);
    let wordTrans = "";
    if (Array.isArray(data) && Array.isArray(data[0])) {
      wordTrans = data[0].map((s) => (s && s[0] ? s[0] : "")).join("").trim();
    }
    let defs = [];
    if (Array.isArray(data[1])) {
      for (const g of data[1]) {
        if (!g || !Array.isArray(g[2])) continue;
        const pos = g[0] || "";
        for (const it of g[2]) if (it && it[0]) defs.push(pos ? `${pos} ${it[0]}` : it[0]);
      }
    }
    if (defs.length && defs.join("；").length < 200) wordTrans = wordTrans || defs.join("；");

    // 2) 有上下文：整句翻译（Google 在整句级别自动消歧）
    if (sentence && sentence.length > 5) {
      try {
        const sUrl =
          "https://translate.googleapis.com/translate_a/single?client=gtx" +
          "&sl=en&tl=zh-CN&dt=t&q=" + encodeURIComponent(sentence);
        const sRes = await fetch(sUrl, { method: "GET" });
        if (sRes.ok) {
          const sData = await sRes.json();
          let sentTrans = "";
          if (Array.isArray(sData) && Array.isArray(sData[0])) {
            sentTrans = sData[0].map((s) => (s && s[0] ? s[0] : "")).join("").trim();
          }
          // 整句翻译作为主释义（含语境义），单词义作为补充
          if (sentTrans) {
            return { translation: wordTrans + "\n" + sentTrans, source: "Google" };
          }
        }
      } catch (e) { /* 整句翻译失败则只返回单词义 */ }
    }

    return { translation: wordTrans || "（无释义）", source: "Google" };
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
        console.log("[VT] translate request:", msg.word, "sentence?", !!msg.sentence);
        const r = await translateWord(msg.word, msg.sentence);
        console.log("[VT] translate result:", msg.word, "->", r.source, r.translation?.slice(0,40));
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
