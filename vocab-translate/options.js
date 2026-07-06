// options.js — 设置页（Vimalinx 账号 + DeepSeek 备用）
const $ = (id) => document.getElementById(id);

const DEFAULTS = { apikey: "", model: "deepseek-v4-flash" };

// ---------- DeepSeek 备用配置 ----------
async function loadBackup() {
  const cfg = await chrome.storage.local.get({
    "cfg:apikey": DEFAULTS.apikey,
    "cfg:model": DEFAULTS.model,
    "vm:clientId": "",
  });
  $("apikey").value = cfg["cfg:apikey"];
  $("model").value = cfg["cfg:model"];
  $("vmClientId").value = cfg["vm:clientId"] || "";
  // 显示当前 redirect URI 提示
  $("redirectHint").textContent = chrome.identity.getRedirectURL();
}

function show(msg, ok) {
  const s = $("status");
  s.textContent = msg;
  s.className = "status " + (ok ? "ok" : "err");
}

$("save").addEventListener("click", async () => {
  await chrome.storage.local.set({
    "cfg:apikey": $("apikey").value.trim(),
    "cfg:model": $("model").value.trim() || DEFAULTS.model,
    "vm:clientId": $("vmClientId").value.trim(),
  });
  show("备用设置已保存。", true);
  refreshVmStatus();
});

$("test").addEventListener("click", async () => {
  const apikey = $("apikey").value.trim();
  const model = $("model").value.trim() || DEFAULTS.model;
  if (!apikey) { show("请先填写 API Key。", false); return; }
  show("测试中…", true);
  try {
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + apikey },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: 'Translate "hello" to Chinese. Reply the meaning only.' }],
        max_tokens: 30, temperature: 0,
      }),
    });
    if (!res.ok) { const t = await res.text().catch(() => ""); show(`失败：HTTP ${res.status} ${t.slice(0,100)}`, false); return; }
    const d = await res.json();
    show(`✅ 直连成功。返回：「${(d.choices?.[0]?.message?.content||"").slice(0,50)}」`, true);
  } catch (e) { show("网络错误：" + e.message, false); }
});

// ---------- Vimalinx 账号 ----------
async function refreshVmStatus() {
  const s = await chrome.runtime.sendMessage({ type: "vm:status" });
  const el = $("vmStatus");
  if (s.loggedIn) {
    const u = s.user || {};
    const q = s.quota || {};
    const remain = q.remain != null ? q.remain : "—";
    const unit = q.displayType === "USD" && q.perUnit ? `$${(remain / q.perUnit).toFixed(2)}` : remain;
    el.className = "vm-status online";
    el.innerHTML =
      `✅ <b>${escapeHtml(u.displayName || u.username || "已登录")}</b>` +
      (u.email ? ` &lt;${escapeHtml(u.email)}&gt;` : "") +
      `<br>账号组：<code>${escapeHtml(s.group || "default")}</code>　` +
      `额度：${escapeHtml(String(unit))}` +
      (s.models && s.models.length ? `　模型：${s.models.map(escapeHtml).join(", ")}` : "") +
      `<br><span class="hint">翻译将通过 <code>api.vimalinx.com/v1</code> 调用 deepseek-v4-flash。</span>`;
    $("vmLogin").style.display = "none";
    $("vmLogout").style.display = "";
  } else {
    el.className = "vm-status offline";
    el.innerHTML = "⚪ 未登录。点击下方按钮通过 Vimalinx/Logto 登录（将打开新窗口）。";
    $("vmLogin").style.display = "";
    $("vmLogout").style.display = "none";
  }
}

$("vmLogin").addEventListener("click", async () => {
  // 先保存 client_id（如果改过）
  await chrome.storage.local.set({ "vm:clientId": $("vmClientId").value.trim() });
  $("vmStatus").textContent = "登录中…（请在弹出的窗口里完成 Logto 登录）";
  $("vmStatus").className = "vm-status";
  try {
    const r = await chrome.runtime.sendMessage({ type: "vm:login" });
    if (r.ok) {
      await refreshVmStatus();
    } else {
      $("vmStatus").textContent = "登录失败：" + (r.error || "未知错误");
      $("vmStatus").className = "vm-status offline";
    }
  } catch (e) {
    $("vmStatus").textContent = "登录失败：" + e.message;
    $("vmStatus").className = "vm-status offline";
  }
});

$("vmLogout").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "vm:logout" });
  await refreshVmStatus();
});

function escapeHtml(s) {
  return (s == null ? "" : String(s)).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

loadBackup();
refreshVmStatus();
