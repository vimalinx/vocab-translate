// vimalinx.js — Vimalinx 统一账号 + AI quota 集成
// 模式：公共客户端 PKCE + 公共 bootstrap
// 边界：只存用户级 api_key / quota 元数据；绝不触碰 provision secret / client secret

const VIMALINX = {
  issuer: "https://auth.vimalinx.com/oidc",
  authEndpoint: "https://auth.vimalinx.com/oidc/auth",
  tokenEndpoint: "https://auth.vimalinx.com/oidc/token",
  bootstrapUrl: "https://api.vimalinx.com/api/vimalinx/client/bootstrap",
  openaiBaseUrl: "https://api.vimalinx.com/v1",
  statusUrl: "https://api.vimalinx.com/api/status",
  // 默认 Logto 公共客户端 ID（用户在设置页可覆盖）
  // 需要在 Logto 注册一个 SPA/Native 类型（public, PKCE, 无 secret）的应用
  defaultClientId: "",
  scope: "openid profile email offline_access",
};

// ---------- PKCE 工具 ----------

function randomBytes(len) {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return arr;
}

function base64url(bytes) {
  const b64 = btoa(String.fromCharCode(...bytes));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlStr(str) {
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(input) {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(hash);
}

// 生成 PKCE verifier + challenge
async function generatePkce() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(await sha256(verifier));
  return { verifier, challenge };
}

// 生成随机 state
function generateState() {
  return base64url(randomBytes(16));
}

// ---------- 存储键 ----------

const VK = {
  clientId: "vm:clientId",
  apikey: "vm:apikey",
  baseUrl: "vm:baseUrl",
  quota: "vm:quota",
  models: "vm:models",
  user: "vm:user",
  refreshToken: "vm:refreshToken",
  group: "vm:group",
  loggedIn: "vm:loggedIn",
};

async function vmGetConfig() {
  const cfg = await chrome.storage.local.get({
    [VK.clientId]: VIMALINX.defaultClientId,
  });
  return {
    clientId: cfg[VK.clientId] || VIMALINX.defaultClientId,
  };
}

// ---------- 登录入口（PKCE via launchWebAuthFlow） ----------

async function vimalinxLogin() {
  const { clientId } = await vmGetConfig();
  if (!clientId) {
    throw new Error(
      "未配置 Logto 公共客户端 ID。请到设置页填写（需要在 Logto 注册一个 SPA/Native 公共客户端）。"
    );
  }

  const redirectUri = chrome.identity.getRedirectURL();
  const pkce = await generatePkce();
  const state = generateState();

  // 暂存 PKCE verifier 和 state，回调时用
  await chrome.storage.local.set({
    "vm:pkceVerifier": pkce.verifier,
    "vm:pkceState": state,
    "vm:redirectUri": redirectUri,
  });

  const authUrl =
    VIMALINX.authEndpoint +
    "?response_type=code" +
    "&client_id=" + encodeURIComponent(clientId) +
    "&redirect_uri=" + encodeURIComponent(redirectUri) +
    "&scope=" + encodeURIComponent(VIMALINX.scope) +
    "&state=" + encodeURIComponent(state) +
    "&code_challenge=" + encodeURIComponent(pkce.challenge) +
    "&code_challenge_method=S256";

  // 打开 Logto 登录页
  const callbackUrl = await chrome.identity.launchWebAuthFlow({
    url: authUrl,
    interactive: true,
  });

  if (!callbackUrl) throw new Error("登录被取消");

  return await handleAuthCallback(callbackUrl);
}

// 处理回调：code → token → bootstrap
async function handleAuthCallback(callbackUrl) {
  const url = new URL(callbackUrl);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    const desc = url.searchParams.get("error_description") || error;
    throw new Error("Logto 登录失败：" + desc);
  }
  if (!code) throw new Error("回调缺少 authorization code");

  // 校验 state
  const stored = await chrome.storage.local.get(["vm:pkceState", "vm:pkceVerifier", "vm:redirectUri"]);
  if (state !== stored["vm:pkceState"]) {
    throw new Error("state 校验失败，可能存在 CSRF 攻击");
  }

  // 用 code 换 JWT
  const tokens = await exchangeCodeForToken(
    code,
    stored["vm:redirectUri"],
    stored["vm:pkceVerifier"]
  );

  // 清理临时 PKCE 数据
  await chrome.storage.local.remove(["vm:pkceVerifier", "vm:pkceState", "vm:redirectUri"]);

  // 调 bootstrap 换用户级 AI 访问
  const bootstrap = await callBootstrap(tokens.id_token || tokens.access_token);

  return bootstrap;
}

// code → token（公共客户端，无 secret）
async function exchangeCodeForToken(code, redirectUri, verifier) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: (await vmGetConfig()).clientId,
    code_verifier: verifier,
  });

  const res = await fetch(VIMALINX.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Token endpoint 失败：HTTP ${res.status} ${txt.slice(0, 120)}`);
  }

  return await res.json(); // { access_token, id_token, refresh_token }
}

// 公共 bootstrap：JWT → user-scoped api_key + quota
async function callBootstrap(jwt) {
  const res = await fetch(VIMALINX.bootstrapUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + jwt,
    },
    body: JSON.stringify({ group: "default", token_name: "vocab-translate-ext" }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Bootstrap 失败：HTTP ${res.status} ${txt.slice(0, 120)}`);
  }

  const json = await res.json();
  if (!json.ok || !json.data) throw new Error("Bootstrap 返回格式异常");
  const d = json.data;

  // 持久化用户级 AI 访问 + 元数据
  await chrome.storage.local.set({
    [VK.apikey]: d.api_key,
    [VK.baseUrl]: d.base_url || VIMALINX.openaiBaseUrl,
    [VK.quota]: {
      total: d.quota,
      remain: d.token_remain_quota ?? d.quota,
      perUnit: d.quota_per_unit,
      displayType: d.quota_display_type,
      price: d.price,
    },
    [VK.models]: d.models || [],
    [VK.group]: d.group || "default",
    [VK.user]: {
      id: d.user_id,
      username: d.username,
      displayName: d.display_name,
      email: d.email,
      avatarUrl: d.avatar_url || d.avatarUrl,
    },
    [VK.loggedIn]: true,
  });

  return json.data;
}

// ---------- 状态查询 ----------

async function vmGetStatus() {
  const s = await chrome.storage.local.get([
    VK.loggedIn,
    VK.apikey,
    VK.user,
    VK.quota,
    VK.models,
    VK.group,
  ]);
  return {
    loggedIn: !!s[VK.loggedIn] && !!s[VK.apikey],
    user: s[VK.user] || null,
    quota: s[VK.quota] || null,
    models: s[VK.models] || [],
    group: s[VK.group] || "default",
  };
}

// 登出：清除本地 session + AI 凭据
async function vimalinxLogout() {
  await chrome.storage.local.remove([
    VK.apikey,
    VK.baseUrl,
    VK.quota,
    VK.models,
    VK.user,
    VK.group,
    VK.loggedIn,
    VK.refreshToken,
  ]);
}

// ---------- 翻译：通过 api.vimalinx.com/v1（OpenAI 兼容） ----------

async function translateByVimalinx(word, sentence) {
  const stored = await chrome.storage.local.get([VK.apikey, VK.baseUrl, VK.models]);
  if (!stored[VK.apikey]) {
    return { translation: "未登录 Vimalinx 账号，请先在设置页登录。", source: "error" };
  }

  const baseUrl = stored[VK.baseUrl] || VIMALINX.openaiBaseUrl;
  const model = "deepseek-v4-flash";

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

  const res = await fetch(baseUrl + "/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + stored[VK.apikey],
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 400,
    }),
  });

  if (res.status === 401) {
    return { translation: "AI 凭据已失效，请重新登录 Vimalinx。", source: "error-auth" };
  }
  if (res.status === 429 || res.status === 402) {
    return { translation: "AI 额度不足，请前往 Vimalinx 充值。", source: "error-quota" };
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    if (txt.includes("No available channel") || txt.includes("group saas_special")) {
      return { translation: "当前账号组不允许调用此模型。", source: "error-model" };
    }
    return { translation: `翻译失败：HTTP ${res.status}`, source: "error" };
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content?.trim();
  if (!content) {
    return { translation: "AI 返回空内容（可能 max_tokens 不足）。", source: "error" };
  }
  return { translation: content, source: "Vimalinx" };
}

export { vimalinxLogin, vimalinxLogout, vmGetStatus, translateByVimalinx };
