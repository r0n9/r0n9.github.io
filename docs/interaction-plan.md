# 博客文章与动态轻量互动方案设计 (Interaction Architecture)

> **版本**：v1.0  
> **更新时间**：2026-10-24  
> **技术选型**：方案 3 —— 基于现有 Cloudflare Worker + Cloudflare D1（Serverless SQLite）一体化自建  
> **设计哲学**：免登录、零额外依赖（< 3KB 原生 JS）、100% 契合 PaperMod 纸质美学、数据完全自主掌控

---

## 1. 目标与背景

本博客采用 **Hugo + GitHub Pages** 纯静态架构，博文与随手记（Moments）以 Markdown 及 WebP 原图形式永久归档于 Git 仓库中（`git clone` 即可完整离线获取全部内容）。

为了让访客能够便捷地参与交流，本方案旨在为**文章（Posts）**与**动态（Moments）**引入轻量级的**点赞（❤️）**与**极简留言（💬）**功能：
1. **免登录门槛**：访客无需注册 GitHub 账号即可互动。
2. **单一服务一体化**：直接复用现有的 [`tools/publisher/cloudflare/worker.js`](../tools/publisher/cloudflare/worker.js) 边缘服务，无需部署和维护第二套独立的评论系统。
3. **动态瀑布流友好**：单页多条动态支持“单个请求批量拉取赞数与评论数”以及“折叠抽屉式按需展开评论”，杜绝前端卡顿。
4. **统一后台管理**：在现有的 Publisher 管理后台中直接集成留言审核与一键删除功能。

---

## 2. 整体架构图

```
┌────────────────────────────────────────────────────────┐
│                   前台 (Hugo 静态博客)                  │
│  ├─ 文章页 (Posts): 文末纸质风点赞胶囊 + 访客留言板         │
│  └─ 动态页 (Moments): 瀑布流卡片 [❤️ 赞] [💬 评论] + 折叠抽屉│
└───────────────────────────┬────────────────────────────┘
                            │ 统一 REST API (CORS 支持)
┌───────────────────────────▼────────────────────────────┐
│       现有的 Publisher Cloudflare Worker (边缘计算)     │
│  ├─ 博客内容发布 API (Git Data API 原子提交 master)     │
│  ├─ 互动 API: 批量状态、点赞计数、防刷校验、访客留言     │
│  └─ 管理后台 (/): 发布管理 + 留言审核与一键清理         │
└───────────────────────────┬────────────────────────────┘
                            │
┌───────────────────────────▼────────────────────────────┐
│            Cloudflare D1 Database (SQLite)             │
│  ├─ likes 表: 目标 Key、IP 哈希、创建时间               │
│  └─ comments 表: 目标 Key、昵称、邮箱、头像、留言内容   │
└────────────────────────────────────────────────────────┘
```

---

## 3. 存储设计 (Cloudflare D1 SQLite)

Cloudflare D1 提供终身免费额度（每日 500 万次读取、10 万次写入、5 GB 存储容量），基于标准 SQLite 构建，支持通过命令行随时一键导出 SQL 备份。

### 3.1 点赞表 (likes)

```sql
CREATE TABLE IF NOT EXISTS likes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_key TEXT NOT NULL,         -- 唯一标示: 如 "/posts/gitea-backup" 或 "moment-20261023175341"
    client_ip_hash TEXT NOT NULL,     -- SHA-256(IP + Salt)，防止单 IP 重复暴力刷赞
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(target_key, client_ip_hash)
);
CREATE INDEX IF NOT EXISTS idx_likes_target ON likes(target_key);
```

### 3.2 评论表 (comments)

```sql
CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_key TEXT NOT NULL,         -- 唯一标示: 如 "/posts/gitea-backup" 或 "moment-20261023175341"
    author TEXT NOT NULL,             -- 访客称呼 (必填，最大 20 字符)
    email TEXT,                       -- 选填邮箱 (用于解析头像，绝不对外展示)
    avatar TEXT,                      -- 头像地址 (自动计算 QQ 头像或 Cravatar)
    content TEXT NOT NULL,            -- 留言正文 (纯文本/适度换行，最大 500 字符)
    ip_hash TEXT,                     -- 审计与频控
    status INTEGER DEFAULT 1,         -- 1: 正常展示, 0: 已软删除/隐藏
    is_admin INTEGER DEFAULT 0,       -- 1: 博主专属身份回复 (黄色/高亮徽章)
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_comments_target ON comments(target_key, status, created_at);
```

---

## 4. API 接口规范

所有接口均由 `tools/publisher/cloudflare/worker.js` 响应，默认支持 CORS 跨域请求。

### 4.1 批量获取互动数据 (Stats)
用于动态流瀑布流初始化以及单篇文章首屏统计。

- **请求**：`GET /api/interactions/stats?keys=moment-01,moment-02,/posts/my-post`
- **响应**：
  ```json
  {
    "ok": true,
    "stats": {
      "moment-20261023175341": { "likes": 5, "comments": 2, "liked": false },
      "moment-20261023030722": { "likes": 3, "comments": 0, "liked": true },
      "/posts/gitea-backup": { "likes": 12, "comments": 4, "liked": false }
    }
  }
  ```

### 4.2 获取目标评论列表 (Comments)
- **请求**：`GET /api/interactions/comments?key=moment-20261023175341`
- **响应**：
  ```json
  {
    "ok": true,
    "comments": [
      {
        "id": 1,
        "author": "折腾爱好者",
        "avatar": "https://cravatar.cn/avatar/...",
        "content": "这个自动化备份脚本非常实用，感谢分享！",
        "is_admin": false,
        "created_at": "2026-10-24 10:30:15"
      }
    ]
  }
  ```

### 4.3 点赞操作 (Like)
- **请求**：`POST /api/interactions/like`
- **载荷 (JSON)**：
  ```json
  {
    "key": "moment-20261023175341"
  }
  ```
- **机制**：
  - 前端利用 `localStorage` 缓存当前访客已赞过的 key 列表；
  - 后端以客户端 `SHA256(IP + 轮转Salt)` 校验唯一性；
  - 成功返回最新赞数：`{ "ok": true, "likes": 6, "liked": true }`。

### 4.4 提交留言 (Comment)
- **请求**：`POST /api/interactions/comment`
- **载荷 (JSON)**：
  ```json
  {
    "key": "moment-20261023175341",
    "author": "小张",
    "email": "zhang@example.com",
    "content": "拍的照片很有氛围感～",
    "hp_token": "" 
  }
  ```
- **机制**：
  - **蜜罐防御 (Honeypot)**：前端渲染一个对普通用户隐藏的空字段 `hp_token`。机器爬虫通常会自动填写所有 input，若该字段非空则直接静默拒绝或丢弃；
  - **速率控制**：同一 IP 30 秒内仅允许提交一次评论；
  - **头像解析**：
    - 若邮箱为 QQ 邮箱（如 `123456@qq.com`），直接解析为 `https://q1.qlogo.cn/g?b=qq&nk=123456&s=100`；
    - 其余邮箱自动生成 Cravatar/Gravatar 镜像地址（`https://cravatar.cn/avatar/{md5(email)}?d=mp`）。

### 4.5 管理员接口 (Admin)
需携带已验证的 `ADMIN_SECRET`：
- `GET /api/admin/comments?page=1&limit=20`：查看全站最新的评论流。
- `DELETE /api/admin/comments/:id`：软删除违规或垃圾评论。

---

## 5. 前端交互与 PaperMod 视觉规范

### 5.1 动态页（Moments 瀑布流）
- **常驻条**：位于每张卡片右下角：
  - `[ ❤️ 赞 <span class="like-num">0</span> ]`
  - `[ 💬 评论 <span class="comment-num">0</span> ]`
- **折叠抽屉 (`.moment-comments-drawer`)**：
  - 点击“评论”平滑展开下拉抽屉；
  - 抽屉采用博客标准的 `var(--code-bg)` 灰纸色背景与 `var(--border)` 边框；
  - 顶部为紧凑的历史评论列表，底部为极简的一行称呼 + 留言框；
  - 再次点击或点击收起按钮平滑关闭。

### 5.2 文章页（Posts 单页）
- 位于文末标签（Tags）之后、翻页链接之前；
- **点赞栏**：居中放置纸质质感胶囊按钮，点击时数字乐观更新（+1）并带有轻柔的心跳跳动（Heart Pulse）动效；
- **留言板**：两栏/单栏响应式表单，保存访客昵称至 `localStorage`，下次无需重新输入。

### 5.3 脚本与性能保障
- 使用约 100 行的原生 ES6 JavaScript（< 3KB），无任何外部库（无需 Vue/React，亦无需 Waline 大客户端）；
- 完美契合 PaperMod 浅色模式与深色模式（利用 CSS 变量动态继承）。

---

## 6. 实施步骤规划

| 步骤 | 任务内容 | 涉及文件 |
| :--- | :--- | :--- |
| **步骤 1** | 在 Cloudflare 创建 D1 数据库并绑定至 Worker | `tools/publisher/cloudflare/wrangler.toml` |
| **步骤 2** | 在 Worker 中增加互动 API 路由与数据库逻辑 | `tools/publisher/cloudflare/worker.js` |
| **步骤 3** | 在 Publisher Web 界面增加「互动管理」Tab | `tools/publisher/cloudflare/worker.js` (HTML_PAGE) |
| **步骤 4** | Hugo 文章页挂载点赞与评论模板 | `layouts/_partials/comments.html` |
| **步骤 5** | Hugo 动态页增加操作栏与折叠抽屉支持 | `layouts/moments/list.html` |
| **步骤 6** | 编写配套样式（Paper 纸质美学与暗色适配） | `assets/css/extended/custom.css` |
| **步骤 7** | 配置 Hugo 环境变量与全流程联调验证 | `hugo.yaml` |

---

## 7. 离线备份与迁移便捷性

因为互动数据完全存放在标准的 SQLite (Cloudflare D1) 中：
- 随时可通过一条命令将全量点赞与评论数据导出为本地 `.sql` 文本文件：
  ```bash
  npx wrangler d1 export blog-interaction --output=./backup_interaction.sql
  ```
- 即使未来迁移到私有 VPS、Docker 或任何支持 SQLite 的服务器，数据可 100% 无缝迁移，没有任何平台锁定。
