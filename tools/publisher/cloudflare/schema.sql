-- ========================================================
-- R0n9's Blog Interaction Database Schema (Cloudflare D1)
-- ========================================================

-- 1. 点赞表 (likes)
CREATE TABLE IF NOT EXISTS likes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_key TEXT NOT NULL,         -- 目标页面唯一标识，如 "/posts/gitea" 或 "moment-20261023175341"
    client_ip_hash TEXT NOT NULL,     -- SHA-256(IP + Salt)，防止重复刷赞
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(target_key, client_ip_hash)
);

CREATE INDEX IF NOT EXISTS idx_likes_target ON likes(target_key);

-- 2. 评论表 (comments)
CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_key TEXT NOT NULL,         -- 目标页面唯一标识
    author TEXT NOT NULL,             -- 访客称呼 (必填)
    email TEXT,                       -- 选填邮箱 (用于解析头像，保密)
    avatar TEXT,                      -- 头像地址 (自动计算 QQ 头像或 Cravatar)
    content TEXT NOT NULL,            -- 留言正文
    ip_hash TEXT,                     -- 审计与频控
    status INTEGER DEFAULT 1,         -- 1: 正常显示, 0: 已软删除/隐藏
    is_admin INTEGER DEFAULT 0,       -- 1: 博主专属徽章
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_comments_target ON comments(target_key, status, created_at);
