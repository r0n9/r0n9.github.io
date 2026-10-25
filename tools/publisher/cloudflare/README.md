# Blog Publisher (Cloudflare Workers 边缘部署版)

专为 Cloudflare Workers 打造的免服务器（Serverless）轻量在线发布台。

无需购买 VPS、无需开着家用 NAS，也无需内网穿透与 Docker，直接在 Cloudflare 全球数百个边缘节点上运行，**0 成本、0 运维、0ms 冷启动、终身免费**（Cloudflare Workers 免费额度每天 100,000 次请求，写博客完全用不完）。

---

## ✨ 亮点特色

1. **单文件零依赖 (Single-File Architecture)**
   - 前端 UI（HTML + CSS + Canvas 转码引擎 + JS）与后端 Git API 调度完全内嵌在单一 `worker.js` 文件中。
   - 体积仅约 35KB，gzip 后仅 8KB，全球首屏秒开。
2. **功能与 Go 版本 100% 对齐**
   - **随手记 (Moments) 与文章 (Posts)** 双选项卡无缝切换；
   - **前端 Canvas 智能 WebP 压制**：大图等比平滑缩放至 1920px 内并高保真转码为 WebP，体积骤降 70%~90%；
   - **剪贴板一键粘贴**：支持全局或输入框内随时 `Ctrl+V` / `Cmd+V` 截屏入队；
   - **双栏 Markdown 实时预览**：代码块、表格、引用即时渲染；
   - **GitHub Git Data API 原子直写**：Markdown 与多张插图生成单次 Commit 直接推送到 `master` 分支，单次发布触发一次 Actions 构建。
3. **安全凭据防泄漏**
   - `GITHUB_TOKEN` 与 `ADMIN_SECRET` 存放在 Cloudflare 官方的加密环境变量（Secrets）中，任何访客及浏览器端无法刺探。
   - 口令校验使用 Web Crypto API 原生 `timingSafeEqual` 防御时序侧信道攻击。
4. **单文件自适应架构 (Self-Adaptive Architecture)**
   - 仅需部署单一的 [`worker.js`](./worker.js) 文件；
   - **未绑定 D1 数据库**时：自动运行为纯净免数据库的在线发布台，界面仅保留随手记与长文发布；
   - **绑定 D1 数据库**时：自动激活全站文章与动态的点赞、免登录留言 API 以及后台「❤️ 互动管理」面板。
5. **独占一行 URL 自动转换为书签卡片**
   - 在随手记或长文中独占一行粘贴网址，发布时边缘端自动抓取 OpenGraph 元数据并 100% 静态化保存为 Notion / Telegram 风格的精美纸质书签卡片。
6. **互动来源智能感知与记录**
   - 访客在文章或动态进行点赞或留言时，边缘端自动记录访客真实 IP、所属地区（国家与城市）、操作系统（如 iOS / macOS / Windows / Android）及浏览器类型（如 Safari / Chrome / 微信），并在后台「❤️ 互动管理」面板分类展示留言与点赞明细。

---

## 🚀 部署指南

您可以选择以下两种方式之一进行部署：

### 方式一：Cloudflare 网页控制台 0 命令行部署（推荐，手机/iPad 也能搞定）

1. 登录 [Cloudflare 控制台](https://dash.cloudflare.com/)，进入左侧 **Workers & Pages (Workers 和 Pages)**。
2. 点击 **Create application (创建应用程序)** -> **Create Worker (创建 Worker)**。
3. 输入名称（例如 `r0n9-publisher`），点击 **Deploy (部署)**。
4. 部署完成后，点击右侧的 **Edit code (编辑代码)**。
5. 将本项目中的 [`tools/publisher/cloudflare/worker.js`](./worker.js) 的全部内容复制并**粘贴覆盖**进去，点击右上角 **Save and deploy (保存并部署)**。
6. 返回该 Worker 的管理页面，进入 **Settings (设置)** -> **Variables and Secrets (变量与机密)**：
   - 点击 **Add (添加)** -> 选择 **Secret** 类型：
     - 名称：`GITHUB_TOKEN`，填入您的 GitHub 访问令牌（需具备仓库 Contents 写权限）。
     - 名称：`ADMIN_SECRET`，填入您自定义的发布访问口令。
     - 名称：`BARK_KEY`，*(可选)* 填入您的 Bark 设备 Key（如 `your_device_key`）或完整 URL（如 `https://api.day.app/your_device_key`）。配置后有新点赞或新留言将自动推送 iOS 提醒，未配置则不推送。
   - *(可选)* 添加普通 **Variable (文本变量)**：
     - `GITHUB_REPO` = `r0n9/r0n9.github.io`
     - `GITHUB_BRANCH` = `master`
     - `AUTHOR` = `R0n9`
     - `SITE_URL` = `https://r0n9.github.io`（用于后台跳转与 Bark 通知链接）
7. 点击保存。现在直接点击 Worker 的访问地址（如 `https://r0n9-publisher.<你的子域名>.workers.dev`），即可在全网任何设备上开启在线发布！

---

### 方式二：使用 Wrangler 命令行一键部署

如果您本地安装有 Node.js：

1. 进入当前目录：
   ```bash
   cd tools/publisher/cloudflare
   ```

2. 安全配置加密环境变量（首次部署只需执行一次）：
   ```bash
   npx wrangler secret put GITHUB_TOKEN
   # 按提示粘贴您的 GitHub 个人访问令牌
   
   npx wrangler secret put ADMIN_SECRET
   # 按提示输入您的发布台密码

   # (可选) 配置 Bark 互动通知
   npx wrangler secret put BARK_KEY
   # 按提示输入您的 Bark Device Key 或完整 URL
   ```

3. 一键发布到 Cloudflare 全球边缘网络：
   ```bash
   npx wrangler deploy
   ```

终端会直接输出部署成功的线上地址（例如 `https://r0n9-blog-publisher.<subdomain>.workers.dev`）。

---

## 🌐 自定义个人域名（可选）

如果您希望使用自己的二级域名（例如 `publish.yourdomain.com`）访问：

1. 在 Cloudflare 该 Worker 的页面中，进入 **Settings (设置)** -> **Triggers (触发器)**。
2. 在 **Custom Domains (自定义域)** 下点击 **Add Custom Domain (添加自定义域)**。
3. 输入您托管在 Cloudflare 上的域名（如 `publish.yourdomain.com`），Cloudflare 会自动完成 DNS 解析配置与免费 SSL 证书签发。

---

## 💬 启用博客轻量互动系统 (文章与动态点赞 + 访客留言)

本发布器现已全面升级为「发布 + 互动一体化服务」。只要为该 Worker 绑定一个免费的 **Cloudflare D1 数据库**，即可点亮全站文章和动态的免登录点赞与留言互动：

### 1. 创建 Cloudflare D1 数据库
- **命令行方式**：
  ```bash
  npx wrangler d1 create blog-interaction
  ```
  命令输出后，将给出的 `database_id` 填入 `wrangler.toml` 中的 `[[d1_databases]]`。
- **网页控制台方式**：
  进入 Cloudflare 控制台 -> **Workers & Pages** -> **D1 SQL Database** -> 点击 **Create database** -> 名称输入 `blog-interaction`。

### 2. 将 D1 绑定到 Worker
- 在 Worker 设置中进入 **Settings (设置)** -> **Bindings (绑定)** -> **Add (添加)** -> 选择 **D1 database**：
  - Variable name (变量名称)：必须命名为 **`DB`**
  - D1 database (选择数据库)：选择刚刚创建的 `blog-interaction`
- 保存并部署后，Worker 会在首次收到互动请求时自动建立 `likes` 和 `comments` 数据表，无需手动执行 SQL！

### 3. 在博客中配置服务地址
在博客根目录的 `hugo.yaml` 中，将 `params.interactionApi` 填入您的 Worker 访问域名：
```yaml
params:
  interactionApi: "https://r0n9-blog-publisher.<你的子域名>.workers.dev"
```
重新部署博客后，文章末尾与动态卡片即可体验全套点赞与留言互动！
