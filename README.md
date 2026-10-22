# R0n9's Blog

R0n9 的个人技术博客，记录 Go、HomeLab、边缘计算、WebRTC、网络安全与日常折腾实践。

- **线上地址**：[https://r0n9.github.io/](https://r0n9.github.io/)
- **技术栈**：[Hugo](https://gohugo.io/) + [PaperMod](https://github.com/adityatelange/hugo-PaperMod)（深度定制极简纸质美学）
- **自动部署**：通过 GitHub Actions 自动化编译并部署至 GitHub Pages
- **Web 发布台**：内置轻量独立在线发布服务 [tools/publisher/](tools/publisher/README.md)（支持长文/随手记在线发布，**支持一键 Serverless 部署至 Cloudflare Workers 边缘网络**）

---

## ✍️ 在线发布管理台 (Web Publisher)

博客在 [`tools/publisher/`](tools/publisher/README.md) 目录下内置了一个独立、极速、无外部依赖的在线 Web 发布服务。无论是在桌面电脑、手机或平板上，无需打开 IDE 或命令行，即可通过浏览器随时随地记录碎碎念或撰写长篇博文。

### 🌟 核心亮点

- ☁️ **原生支持 Cloudflare Workers 边缘无服务器部署（一大亮点！）**：
  - **彻底告别服务器**：无需 VPS、无需开着家用 NAS、无需内网穿透与 Docker 守护进程。
  - **0 成本 / 0 运维 / 0ms 冷启动**：借助 Cloudflare 全球数百个边缘节点，终身免费托管（免费额度每天 100,000 次请求，写博客完全用不完），在手机浏览器随时秒开即发！
  - **部署极简**：支持单文件在 Cloudflare 控制台页面直接粘贴部署，详见 [Cloudflare 部署指南](tools/publisher/cloudflare/README.md)。
- ⚡️ **GitHub API 原子直写**：生成的 Markdown 及配图通过 GitHub REST API 原子提交至 `master` 分支，单次发布触发一次 Actions 构建，杜绝中间脏状态。
- 🖼️ **Canvas 智能转码 WebP**：支持剪贴板截图直接粘贴（`Ctrl+V` / `Cmd+V`），浏览器端利用 Canvas 自动将大图等比缩放并高保真转码为 `.webp` 格式（体积立降 70%~90%）。
- 📝 **长文与随手记双模式**：随手记配图与正文全自动归档；文章支持双栏实时 Markdown 渲染。
- 🚀 **完整说明与部署指南**：请阅读 [tools/publisher/README.md](tools/publisher/README.md)。

### 多种部署形态随心选：

1. **☁️ Cloudflare Workers 部署（最推荐，免服务器 / 零成本 / 全球加速）**：
   无需安装任何软件，在网页端复制粘贴单文件即可上线，详见 [tools/publisher/cloudflare/README.md](tools/publisher/cloudflare/README.md)。
2. **🐳 Docker / Docker Compose 部署 (推荐 NAS / HomeLab)**：
   ```bash
   docker run -d -p 13133:13133 --env-file tools/publisher/.env ghcr.io/r0n9/blog-publisher:latest
   ```
3. **💻 本地 / 个人电脑直接运行 (Go 1.21+)**：
   ```bash
   cd tools/publisher && go run .
   ```

---

## 📝 发表新文章完整流程

### 1. 创建文章文件

有两种创建方式，任选其一：

#### 方式一：使用 Hugo 命令行创建（推荐）
在项目根目录运行命令：
```bash
hugo new posts/2026_10_23_你的文章标题.md
```
> 项目已内置 `archetypes/default.md` 模板，该命令会自动在 `content/posts/` 目录下生成带有规范 Front Matter 元信息的 Markdown 文件。

#### 方式二：手动新建文件
直接在 `content/posts/` 目录下新建 `.md` 文件，推荐命名格式与现有文章保持一致：`YYYY_MM_DD_文章标题.md`。

---

### 2. 编写 Front Matter 与正文

打开新建的文章文件，在顶部完善元信息（Front Matter）：

```yaml
---
title: "你的文章完整标题"
date: 2026-10-23T10:00:00+08:00
draft: false
description: "这里写文章的简短摘要，展示在首页卡片和搜索结果中。"
categories:
  - "技术"
tags:
  - "Go"
  - "Docker"
---

这里开始写 Markdown 正文内容...
```

#### 关键字段说明：
| 字段 | 说明 | 示例 / 可选值 |
| :--- | :--- | :--- |
| `title` | 文章标题 | `"Docker安装的Mysql数据库定时备份脚本"` |
| `date` | 发布时间（归档页与搜索结果依此排序） | `2026-10-23T10:00:00+08:00` |
| `draft` | 是否为草稿（`false` 正式发布，`true` 仅本地可见） | `false` |
| `description` | 文章摘要（用于首页卡片与搜索命中摘要） | `"文章的简短介绍..."` |
| `categories` | 文章分类 | `["技术", "开发"]` |
| `tags` | 文章标签 | `["Docker", "MySQL", "脚本"]` |

---

### 3. 插入图片与资源

1. 将图片放入 **`static/images/`** 目录中（例如 `static/images/my-screenshot.png`）。
2. 在 Markdown 正文中直接使用绝对路径引用：
   ```markdown
   ![图片说明](/images/my-screenshot.png)
   ```

---

### 4. 本地实时预览（可选）

在终端启动本地预览服务：
```bash
hugo server -D
```
浏览器打开 [http://localhost:1313/](http://localhost:1313/) 即可查看效果，修改文件保存时会自动实时刷新（Live Reload）。

---

### 5. 提交并发布上线

博客配置了 GitHub Actions 自动化工作流，只要将代码推送到 `master` 分支，GitHub 会自动编译 Hugo 并发布到 GitHub Pages：

```bash
git add .
git commit -m "feat(posts): 发布新文章《你的文章标题》"
git push origin master
```

推送完成后，等待约 30 秒至 1 分钟即可在线上查看新文章。

---

## 💬 发表新动态（Moments）流程

博客提供独立于长篇博文的“随手记录 / 动态”流，支持文字、Markdown 语法、多图自适应画廊排版及全屏灯箱浏览。

### 方式一：使用内置一键发表脚本（极速推荐）
在项目根目录下直接运行：
```bash
# 纯文字动态
./bin/moment "今天折腾了下Parsec串流，延迟很低！"

# 带配图动态（自动复制图片并映射路径）
./bin/moment "组装了一个小NAS，上机测试跑分" /path/to/photo1.jpg /path/to/photo2.png

# 交互式输入（无参数直接运行）
./bin/moment
```

### 方式二：手动创建 Markdown 文件
1. 在 `content/moments/` 目录下新建 `.md` 文件（命名如 `2026-10-23-01.md`）：
   ```yaml
   ---
   title: "动态"
   date: 2026-10-23T11:50:00+08:00
   draft: false
   searchHidden: true
   images:
     - "/images/moments/photo1.jpg"
     - "/images/moments/photo2.jpg"
     - "/images/moments/photo3.jpg"
   ---

   随手记录文字内容，支持 Markdown 超链接与语法。
   ```
2. 图片放入 `static/images/moments/` 目录中。
3. 智能画廊会根据图片张数自动呈现优雅的 Solo 单图、Pair 双图、Triple 画报风、Grid 四宫格或 Mosaic 拼贴网格，并支持点击灯箱放大轮播！

---

## 🛠️ 本地常用开发命令

| 命令 | 说明 |
| :--- | :--- |
| `hugo server -D` | 启动本地开发服务器（包含草稿文章），支持热更新 |
| `hugo --gc --minify` | 本地执行生产环境完整编译（输出至 `public/` 目录） |
| `hugo new posts/<filename>.md` | 快速创建长篇文章模板 |
| `./bin/moment "<内容>" [图片...]` | 快速发表一条随手动态 |
| `go run ./tools/publisher` | 启动 Web 内容发布管理服务 (http://localhost:13133) |

---

## 📂 项目核心目录结构

```text
├── archetypes/           # 新建内容模板 (default.md / moment.md)
├── assets/
│   ├── css/extended/     # 自定义样式 (custom.css 极简纸质美学、画廊与动效)
│   └── js/               # 自定义交互脚本 (fastsearch.js 搜索 / moments-lightbox.js 灯箱)
├── bin/
│   └── moment            # 动态快速发表辅助脚本
├── content/
│   ├── about.md          # 关于页面
│   ├── search.md         # 搜索页面
│   ├── posts/            # 博客正式长文目录
│   └── moments/          # 随手记录微语动态目录
├── layouts/              # 自定义页面模板（覆盖 PaperMod 默认模板）
│   ├── archives.html     # 极简时间轴归档页
│   ├── search.html       # 极简搜索页
│   ├── index.json        # 搜索索引生成模板
│   ├── moments/          # 动态列表页与单页模板 (list.html / single.html)
│   └── _partials/        # 面包屑等公共组件
├── static/
│   ├── favicon.ico       # 站点图标
│   └── images/           # 博客插图存放目录 (images/moments/)
├── tools/
│   └── publisher/        # 独立轻量在线发布管理台 (Web UI, 支持文章/动态一键提交 GitHub)
│       └── cloudflare/   # Cloudflare Workers 边缘免服务器版本 (0成本/0运维/网页直接粘贴部署)
├── hugo.yaml             # 站点全局配置文件
└── .github/workflows/    # GitHub Actions 自动化部署工作流 (Pages 部署 / Publisher 构建)
```
