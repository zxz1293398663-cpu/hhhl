# hhhl 社区 NewAPI 登录适配

为 **hhhl 社区** (dc.hhhl.cc) 专用的 OAuth 适配层，让社区用户能用 Misskey 账号登录 New API。

> 如果你有其他 Misskey/Sharkey 实例，fork 后只需改 `worker.js` 第 1 行的 `MISSKEY_HOST` 即可使用。

---

## 为什么需要这个

Misskey 自带的 `/oauth/*` 端点走的是 **IndieAuth**,不是传统 OAuth2,有两道硬门槛,普通 OAuth2 客户端过不去:

| Misskey IndieAuth 的要求 | 普通 OAuth2 客户端(如 New API) | 结果 |
| --- | --- | --- |
| **强制 PKCE(S256)**,请求必须带 `code_challenge` | 多数客户端不支持、无法开启 PKCE | 直连失败 |
| **`client_id` 必须是一个能被服务器抓取的 https URL**(IndieAuth 客户端发现),页面里要声明 `redirect_uri` | 把 `client_id` 当普通字符串 | `Invalid client_id` |
| **没有 userinfo 端点**,取用户信息要 `POST /api/i` + Bearer | 期望标准 `GET /userinfo` | 字段对不上 |

这个 Worker 改用 **MiAuth**(Misskey 的另一套更简单的授权机制),一次性绕开上面三道坎,对外暴露 `/authorize`、`/token`、`/userinfo` 三个标准端点。

---

## 工作原理

```
New API                Worker                         Misskey/Sharkey
  │                      │                                  │
  │  GET /authorize ───► │                                  │
  │                      │  302 ─► /miauth/{sid}?callback ─►│  用户在 Misskey 登录授权
  │                      │                                  │
  │                      │ ◄─ 302 回 Worker /callback ──────│
  │ ◄─ 302 带 code ──────│  (code = sid)                    │
  │                      │                                  │
  │  POST /token ──────► │                                  │
  │   (code)             │  POST /api/miauth/{sid}/check ──►│  校验会话,换 token
  │ ◄─ access_token ─────│ ◄─ { ok, token } ────────────────│
  │                      │                                  │
  │  GET /userinfo ────► │                                  │
  │   (Bearer token)     │  POST /api/i { i: token } ──────►│  取用户资料
  │ ◄─ {sub,...} ────────│ ◄─ { id, username, name } ───────│
```

核心技巧:把 MiAuth 的 **sessionId(UUID)** 当作 OAuth 的 **authorization code** 在两边之间传递。

---

## 端点说明

### `GET /authorize`
入口。接收 New API 传来的 `redirect_uri` 和 `state`,生成一个 sessionId,重定向到 Misskey 的 MiAuth 授权页。

- 申请的权限固定为 `permission=read:account`(只读账号信息,够用了)。
- 把 `redirect_uri` / `state` / `sid` 透传进 Worker 自己的 `/callback`。

### `GET /callback`
MiAuth 授权完成后 Misskey 回跳到这里。Worker 把之前透传的 `sid` 当作 `code`,连同 `state` 一起重定向回 New API 的 `redirect_uri`。

> 注意:MiAuth 回调时**不会**带回 `session` 参数,所以 sessionId 必须由 Worker 自己透传(`sid`),不能从回调 query 里读。

### `POST /token`(也兼容 `GET ?code=`)
用 `code`(即 sessionId)调 Misskey `POST /api/miauth/{sid}/check` 换取真正的 access token,以标准 OAuth2 形式返回:

```json
{ "access_token": "...", "token_type": "Bearer" }
```

### `GET /userinfo`(也兼容 `?access_token=`)
用 Bearer token 调 Misskey `POST /api/i`,转换成 OIDC 标准字段返回:

```json
{
  "sub": "<misskey user id>",
  "preferred_username": "<username>",
  "name": "<display name>"
}
```

> 刻意**不返回 email**。如需邮箱,在 `userInfo` 对象里自行添加 `email: userData.email`(且 MiAuth permission 需要 `read:account`,实例也要允许)。

---

## 部署

### 方式一：一键部署（推荐）

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/GuJi08233/hhhl)

> ⚠️ 一键部署后需要在 Cloudflare Dashboard 里修改 Worker 的环境变量或代码，把 `MISSKEY_HOST` 改成你的实例地址。

### 方式二：手动部署

#### 1. 改实例地址
编辑 `worker.js` 第 1 行,改成你的 Misskey/Sharkey 实例地址(注意拼写,别漏字母):

```js
const MISSKEY_HOST = 'https://dc.hhhl.cc';
```

### 2. 部署到 Cloudflare Workers
- 用 [Wrangler](https://developers.cloudflare.com/workers/wrangler/):`wrangler deploy`
- 或直接在 Cloudflare Dashboard → Workers 里粘贴 `worker.js` 内容保存。

部署后记下 Worker 的访问域名,例如 `https://oauth-proxy.example.workers.dev`(下面记为 `<WORKER>`)。

---

## New API 侧配置

在 New API 的「OAuth 提供商」配置里:

| 字段 | 值 |
| --- | --- |
| 显示名称 | `dc.hhhl.cc` |
| Slug | `hhhl` |
| 图标 | `https://dc.hhhl.cc/client-assets/about-icon.png?v=uf3` |
| Authorization Endpoint | `<WORKER>/authorize` |
| Token Endpoint | `<WORKER>/token` |
| User Info Endpoint | `<WORKER>/userinfo` |
| Client ID | 任意字符串(Worker 不校验,如 `newapi`) |
| Client Secret | 任意(Worker 不校验) |
| Scopes | 任意或留空(Worker 不读这个字段) |

> 显示名称 / Slug / 图标 只是 New API 登录按钮上的展示信息,不参与 OAuth 流程,填什么都不影响登录能否成功。其中 Slug 会出现在 New API 的回调地址里(如 `.../oauth/hhhl/callback`),确定后尽量别改。

字段映射(对齐 Worker 的 OIDC 输出):

| New API 字段映射 | 填 |
| --- | --- |
| 用户 ID 字段 | `sub` |
| 用户名字段 | `preferred_username` |
| 显示名称字段 | `name` |
| 邮箱字段 | 留空(Worker 不返回 email) |

> **关键:三个端点必须指向 `<WORKER>`,绝对不要填 Misskey 的 `/oauth/*`**——那会重新撞上 IndieAuth + PKCE 的坎。

---

## 排错

走一遍登录,用浏览器 F12 网络面板看卡在哪一步:

| 现象 | 可能原因 |
| --- | --- |
| 卡在 Misskey 授权页之前 | `MISSKEY_HOST` 拼错,或 New API 的 Authorization Endpoint 没指向 Worker |
| 授权后回调报错 / code 为空 | 检查 New API 那边登记的 `redirect_uri` 与实际一致 |
| `/token` 返回 `invalid_grant` | MiAuth 会话已过期(超时未授权),或 sessionId 没正确透传 |
| `/userinfo` 返回 `invalid_token` | token 失效,或 Misskey `/api/i` 返回了非预期内容 |
| 字段映射后用户名/ID 为空 | New API 字段映射没填成 `sub` / `preferred_username` / `name` |

---

## 安全说明

- Worker **不校验 Client ID / Client Secret**——任何知道 Worker 地址的人都能发起授权流程。授权本身仍需用户在 Misskey 端真实登录,所以拿不到别人的 token;但若担心被当作开放代理滥用,可自行在各端点加一层简单的密钥校验。
- `read:account` 是只读权限,Worker 不申请任何写权限。
- userinfo 默认剥离 email,不向下游泄露邮箱。

---

## 文件

- `worker.js` — Cloudflare Worker 全部逻辑(单文件)。

## 其他实例使用

如果你想在自己的 Misskey/Sharkey 实例上使用：

1. Fork 本仓库
2. 修改 `worker.js` 第 1 行：
   ```js
   const MISSKEY_HOST = 'https://你的实例地址';
   ```
3. 部署到 Cloudflare Workers
4. 按上面的配置说明在 New API 里设置端点

---

## 社区

- **hhhl 社区**: https://dc.hhhl.cc