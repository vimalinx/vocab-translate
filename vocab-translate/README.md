# Vocab Translate — 划词翻译 + 词汇本 + 释义测验

一个 Chromium / Chrome 浏览器扩展，**点击网页上的英文单词即显示中文释义**，自动：

- 📖 记录你查过的每一个词
- 🔢 统计词频（同一词查询次数累加）
- 📝 保存查询时的**原句上下文**
- 🎨 在你打开新页面时，把**已查过的词用淡黄色背景高亮**（颜色随页面明暗自适应）
- 🧠 用你查过的词 + 当时的原句生成**释义选择题测验**

---

## 安装

1. 打开 `chrome://extensions`（或 Edge 的 `edge://extensions`）。
2. 右上角开启 **「开发者模式 / Developer mode」**。
3. 点击 **「加载已解压的扩展程序 / Load unpacked」**。
4. 选择本目录 `vocab-translate/`。
5. 扩展图标出现在工具栏，完成。

> 翻译走 **Vimalinx 统一账号**（`api.vimalinx.com/v1`，`deepseek-v4-flash`）生成词典级释义（带音标、词性、多义项）；未登录时可用 DeepSeek 直连 key 备用；两者都不可用时回退 Google Translate（免 key 机器翻译）。

---

## 配置 Vimalinx 统一账号（推荐）

本扩展通过 **Vimalinx 统一账号体系**调用 AI：登录身份由 Logto (`auth.vimalinx.com`) 集中管理，翻译额度走你的 Vimalinx 账户，模型固定为 `deepseek-v4-flash`。

### 前置：注册 Logto 公共客户端（一次性）

浏览器扩展需要自己的 OIDC 公共客户端，不能复用移动端的 `nexusnative`（它的 redirect URI 是 `nexus://`）。

1. 安装扩展后，在 `chrome://extensions` 找到本扩展的 **ID**（一串 32 位字母）。
2. 扩展的 redirect URI 是 `https://<扩展ID>.chromiumapp.org/`。
3. 到 Logto 管理台注册一个 **SPA / Native** 类型应用（**公共客户端，PKCE，无 secret**），redirect URI 填上面的 `https://<扩展ID>.chromiumapp.org/`。
4. 拿到 `client_id`。

### 登录

1. 右键扩展图标 → **「选项 / Options」**，或点工具栏图标 → **⚙️ 设置**。
2. 在 **「Logto 公共客户端 ID」** 填入上一步的 `client_id`。
3. 点 **「登录 Vimalinx」** —— 会弹出 Logto 登录窗口（密码/MFA 都在 Logto 完成，扩展不接触）。
4. 登录成功后设置页会显示账号、额度、账号组、可用模型。

> **安全边界**：扩展只存 bootstrap 返回的用户级 `api_key` 和额度元数据；**绝不**包含 provision secret、客户端 secret、或任何平台级密钥。

### 翻译优先级

```
Vimalinx 统一账号 (api.vimalinx.com/v1)   ← 已登录时首选
   ↓ 失败/未登录
DeepSeek 直连 key (设置页备用栏)          ← 填了 key 时用
   ↓ 失败/未填
Google Translate 公开端点                 ← 免 key 兜底
```

### 失败行为

- AI 凭据失效（401 无效令牌）→ 提示重新登录 Vimalinx
- 额度不足（402/429）→ 提示前往 Vimalinx 充值
- 模型不允许（saas_special 组限制）→ 提示当前账号组不允许调用此模型

---

## 配置 DeepSeek 直连（备用）

未登录 Vimalinx 时可用。在设置页 **「DeepSeek 直连（备用）」** 区域填入 key（[platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys)），点「测试直连」验证。

---

## 使用方法

### 1. 划词翻译
打开任意英文网页，**直接点击一个单词**（不需要选中），单词旁边会浮现释义小窗：

```
┌──────────────────────────────┐
│ serendipity         [DeepSeek] ✕│
│ 音标：/ˌserənˈdɪpəti/           │
│ 名词 意外发现美好事物的能力；机缘巧合 │
└──────────────────────────────┘
```

- 点击 ✕ 或按 `Esc` 或滚动页面关闭浮窗。
- 该词会**立即在当前页被淡黄高亮**，并写入词汇本。

### 2. 工具栏弹窗
点击工具栏图标：
- 手动输入单词翻译并记录
- 查看已记录词数
- 打开词汇本 / 测验
- 清空所有记录

### 3. 词汇本（`vocab.html`）
按词频降序列出所有查过的词，每条显示：

| 单词 | 释义 | 词频 | 来源句子 |
|------|------|------|----------|

- 🔍 实时筛选（按单词或释义）
- ↕ 排序：词频 / 最近查询 / 字母序
- ✏️ 点击「编辑」可手动修改释义
- 🗑 删除单条
- 📥 导出 CSV

### 4. 释义测验（`quiz.html`）
三种出题模式：

| 模式 | 题面 | 选项 |
|------|------|------|
| **原句填空（选释义）** | 显示你当初查这个词时的原句，目标词挖空 `____` | 4 个中文释义，选正确的 |
| **看词选释义** | 显示英文单词 | 4 个中文释义 |
| **看释义选单词** | 显示中文释义 | 4 个英文单词 |

- 干扰项从你词汇本里的其他词中随机抽取。
- 答错时会高亮正确答案，并显示该词的词频。
- 结束后给出正确率和评语。

> **提示**：「原句填空」模式只对有来源句子的词出题。所以查词时尽量在**完整的英文句子**上点击，而不是孤立的标题词。

---

## 已查词高亮说明

当你打开新页面时，扩展会扫描页面文本，把你词汇本里出现过的词用半透明黄色背景（`rgba(255,200,0,0.13)`）标出来，鼠标悬停时变深。这样你扫读时能一眼看出「这个词我查过了」，同时颜色很淡不会干扰阅读。背景偏暗的页面会自动切换高亮配色。

> 高亮在页面加载后约 400ms 应用；对 SPA 动态内容会自动重扫。

---

## 数据与隐私

- 所有词汇记录存在浏览器的 `chrome.storage.local`，**不联网、不上传**。
- 翻译请求发往 `translate.googleapis.com`（与 Google 翻译网页版相同端点），只传递被查询的单词本身。
- 点击扩展弹窗里的「清空所有记录」可一键删除全部数据。

---

## 文件结构

```
vocab-translate/
├── manifest.json     # MV3 清单
├── background.js     # Service Worker：翻译 + 存储 + 消息中枢
├── content.js        # 内容脚本：点击取词、浮窗、已查词高亮
├── content.css       # 高亮与浮窗样式
├── popup.html/js     # 工具栏弹窗
├── vocab.html/js     # 词汇本页面
└── quiz.html/js      # 释义测验页面
```

## 存储结构

每个词存为一个 key `v:<word>`：

```json
{
  "word": "serendipity",
  "translation": "意外发现美好事物的能力",
  "count": 3,
  "first": 1783317130951,
  "last": 1783317200000,
  "sentences": ["a serendipity moment", "..."]
}
```

---

## 已知限制

- 翻译端点是非官方接口，高频请求可能被限流；扩展内置了结果缓存。
- 取词基于 `caretRangeFromPoint`，对非常规渲染（Canvas、PDF 内嵌、Shadow DOM 深层）可能取不到。
- 仅处理拉丁字母单词；中文整段翻译不在本扩展范围。
