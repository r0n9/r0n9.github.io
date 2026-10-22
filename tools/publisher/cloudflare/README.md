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
   - *(可选)* 添加普通 **Variable (文本变量)**：
     - `GITHUB_REPO` = `r0n9/r0n9.github.io`
     - `GITHUB_BRANCH` = `master`
     - `AUTHOR` = `R0n9`
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
