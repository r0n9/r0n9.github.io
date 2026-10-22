# R0n9's Blog

R0n9 的个人技术博客，记录 Go、HomeLab、边缘计算、WebRTC、网络安全与日常折腾实践。

- **线上地址**：[https://r0n9.github.io/](https://r0n9.github.io/)
- **技术栈**：[Hugo](https://gohugo.io/) + [PaperMod](https://github.com/adityatelange/hugo-PaperMod)（深度定制极简纸质美学）
- **自动部署**：通过 GitHub Actions 自动化编译并部署至 GitHub Pages

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

## 🛠️ 本地常用开发命令

| 命令 | 说明 |
| :--- | :--- |
| `hugo server -D` | 启动本地开发服务器（包含草稿文章），支持热更新 |
| `hugo --gc --minify` | 本地执行生产环境完整编译（输出至 `public/` 目录） |
| `hugo new posts/<filename>.md` | 快速创建新文章模板 |

---

## 📂 项目核心目录结构

```text
├── archetypes/           # 新建内容模板 (default.md)
├── assets/
│   ├── css/extended/     # 自定义样式 (custom.css 极简纸质美学与动效)
│   └── js/               # 自定义搜索交互脚本 (fastsearch.js)
├── content/
│   ├── about.md          # 关于页面
│   ├── search.md         # 搜索页面
│   └── posts/            # 博客文章目录
├── layouts/              # 自定义页面模板（覆盖 PaperMod 默认模板）
│   ├── archives.html     # 极简时间轴归档页
│   ├── search.html       # 极简搜索页
│   ├── index.json        # 搜索索引生成模板
│   └── _partials/        # 面包屑等公共组件
├── static/
│   ├── favicon.ico       # 站点图标
│   └── images/           # 博客插图存放目录
├── hugo.yaml             # 站点全局配置文件
└── .github/workflows/    # GitHub Actions 自动化部署工作流
```
