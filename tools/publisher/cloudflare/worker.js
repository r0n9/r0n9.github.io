/**
 * R0n9's Blog Publisher - Cloudflare Worker Edition
 * 极简、免服务器、零运维的边缘博客在线发布服务
 *
 * 环境变量 (通过 Cloudflare 控制台或 wrangler secret 设置)：
 * - GITHUB_TOKEN: 具备仓库 Contents 写入权限的 GitHub 访问令牌 (Secret)
 * - ADMIN_SECRET: Web 页面访问与发布管理口令 (Secret)
 * - BARK_KEY: (可选) Bark iOS 实时通知推送 Device Key 或完整 URL (Secret/Variable)
 * - GITHUB_REPO: 目标仓库 (如 "r0n9/r0n9.github.io")
 * - GITHUB_BRANCH: 分支名 (默认 "master")
 * - AUTHOR: 默认署名作者 (默认 "R0n9")
 * - SITE_URL: 博客公开地址 (默认 "https://r0n9.github.io")
 */

// ----------------------------------------------------
// 1. 工具辅助函数
// ----------------------------------------------------

function corsHeaders(request) {
  const origin = (request && request.headers.get('Origin')) || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Secret',
    'Access-Control-Max-Age': '86400'
  };
}

function getSiteUrl(env) {
  return (env.SITE_URL || 'https://r0n9.github.io').replace(/\/+$/, '');
}

const MAX_UPLOAD_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_COUNT = 20;
const MAX_CONTENT_CHARS = 1_000_000;
const ALLOWED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif']);

function validateUploadRequest(request, maxBytes = MAX_UPLOAD_BYTES) {
  const contentLength = Number(request.headers.get('Content-Length') || 0);
  return !contentLength || contentLength <= maxBytes;
}

function getImageExtension(file) {
  const dot = file.name.lastIndexOf('.');
  const ext = dot >= 0 ? file.name.substring(dot).toLowerCase() : '';
  if (ALLOWED_IMAGE_EXTENSIONS.has(ext)) return ext;
  const typeExt = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/avif': '.avif'
  }[file.type];
  return typeExt || '';
}

function jsonResponse(data, status = 200, headers = {}, request = null) {
  const cors = request ? corsHeaders(request) : {};
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...cors,
      ...headers
    }
  });
}

function jsonError(message, status = 400, request = null) {
  return jsonResponse({ ok: false, error: message }, status, {}, request);
}

// 防时序侧信道攻击的口令校验
async function verifySecret(provided, expected) {
  if (!provided || !expected || typeof provided !== 'string' || typeof expected !== 'string') {
    return false;
  }
  const enc = new TextEncoder();
  const a = enc.encode(provided);
  const b = enc.encode(expected);
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  return crypto.subtle.timingSafeEqual(a, b);
}

// 从请求中提取 Token
function extractAuthToken(request) {
  const authHeader = request.headers.get('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7).trim();
  }
  const secretHeader = request.headers.get('X-Admin-Secret');
  if (secretHeader) {
    return secretHeader.trim();
  }
  const cookie = request.headers.get('Cookie');
  if (cookie) {
    const match = cookie.match(/admin_secret=([^;]+)/);
    if (match) {
      try {
        return decodeURIComponent(match[1].trim());
      } catch (_) {
        return match[1].trim();
      }
    }
  }
  return '';
}

// 获取中国标准时间格式化元数据
function getChinaTime() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  const parts = formatter.formatToParts(now);
  const get = (type) => parts.find(p => p.type === type)?.value || '00';
  const Y = get('year');
  const M = get('month');
  const D = get('day');
  const h = get('hour');
  const m = get('minute');
  const s = get('second');

  return {
    isoDate: `${Y}-${M}-${D}T${h}:${m}:${s}+08:00`,
    fileDate: `${Y}_${M}_${D}`,
    timestampPrefix: `${Y}-${M}-${D}-${h}${m}${s}`,
    momentHash: `${Y}${M}${D}${h}${m}${s}`,
    displayDate: `${Y}-${M}-${D} ${h}:${m}`
  };
}

function sanitizeFilename(name) {
  const clean = name.replace(/[/\\:*?"<>|]/g, '').trim();
  return clean || 'post';
}

function bufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  const chunkSize = 8192;
  for (let i = 0; i < len; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunkSize, len)));
  }
  return btoa(binary);
}

// ----------------------------------------------------
// 2. GitHub Git Data API 交互
// ----------------------------------------------------

async function githubRequest(env, method, endpoint, body) {
  const repoFull = env.GITHUB_REPO || 'r0n9/r0n9.github.io';
  const [owner, repo] = repoFull.split('/');
  const url = `https://api.github.com/repos/${owner}/${repo}${endpoint}`;

  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'r0n9-blog-publisher-worker',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const resData = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`GitHub API [${method} ${endpoint}] 失败 (${res.status}): ${resData.message || JSON.stringify(resData)}`);
  }
  return resData;
}

// 原子提交多个文件 (文本 + 二进制 Blob)
async function commitFilesToGitHub(env, message, files) {
  const branch = env.GITHUB_BRANCH || 'master';
  const repoFull = env.GITHUB_REPO || 'r0n9/r0n9.github.io';
  const [owner, repo] = repoFull.split('/');

  // 1. 获取目标分支当前最新 Commit SHA
  const refData = await githubRequest(env, 'GET', `/git/ref/heads/${branch}`);
  const latestCommitSHA = refData.object.sha;

  // 2. 获取该 Commit 对应的 Tree SHA
  const commitData = await githubRequest(env, 'GET', `/git/commits/${latestCommitSHA}`);
  const baseTreeSHA = commitData.tree.sha;

  // 3. 构建 Tree Entries (二进制创建 Blob，文本直接嵌 content)
  const treeEntries = [];
  for (const f of files) {
    if (f.isBinary) {
      const blobData = await githubRequest(env, 'POST', '/git/blobs', {
        content: f.contentBase64,
        encoding: 'base64'
      });
      treeEntries.push({
        path: f.path,
        mode: '100644',
        type: 'blob',
        sha: blobData.sha
      });
    } else {
      treeEntries.push({
        path: f.path,
        mode: '100644',
        type: 'blob',
        content: f.content
      });
    }
  }

  // 4. 创建新 Git Tree
  const newTree = await githubRequest(env, 'POST', '/git/trees', {
    base_tree: baseTreeSHA,
    tree: treeEntries
  });

  // 5. 创建新 Commit
  const newCommit = await githubRequest(env, 'POST', '/git/commits', {
    message: message,
    tree: newTree.sha,
    parents: [latestCommitSHA]
  });

  // 6. 更新分支 HEAD
  await githubRequest(env, 'PATCH', `/git/refs/heads/${branch}`, {
    sha: newCommit.sha,
    force: false
  });

  return `https://github.com/${owner}/${repo}/commit/${newCommit.sha}`;
}

// ----------------------------------------------------
// 3. 业务路由处理
// ----------------------------------------------------

async function handleAuthVerify(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError('无效的 JSON 请求体');
  }

  const isValid = await verifySecret(body.secret, env.ADMIN_SECRET);
  if (!isValid) {
    return jsonError('口令错误，验证失败', 401);
  }

  const repo = env.GITHUB_REPO || 'r0n9/r0n9.github.io';
  const branch = env.GITHUB_BRANCH || 'master';
  const author = env.AUTHOR || 'R0n9';

  return jsonResponse({
    ok: true,
    repo,
    branch,
    author
  }, 200, {
    'Set-Cookie': `admin_secret=${encodeURIComponent(body.secret)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`
  }, request);
}

async function handlePublishMoment(request, env) {
  const token = extractAuthToken(request);
  const isAuthed = await verifySecret(token, env.ADMIN_SECRET);
  if (!isAuthed) {
    return jsonError('口令未提供或不正确，无权访问', 401);
  }

  if (!validateUploadRequest(request)) {
    return jsonError('上传内容不能超过 32 MB', 413, request);
  }
  const formData = await request.formData();
  const content = (formData.get('content') || '').toString().trim();
  const author = (formData.get('author') || env.AUTHOR || 'R0n9').toString().trim();
  const imageFiles = formData.getAll('images');

  if (content.length > MAX_CONTENT_CHARS) {
    return jsonError('动态正文不能超过 1,000,000 个字符', 413, request);
  }

  if (imageFiles.length > MAX_IMAGE_COUNT) {
    return jsonError(`最多上传 ${MAX_IMAGE_COUNT} 张图片`, 413, request);
  }

  if (!content && imageFiles.length === 0) {
    return jsonError('动态文字内容与配图不能均为空');
  }

  const timeMeta = getChinaTime();
  const filesToCommit = [];
  const webImagePaths = [];

  // 处理配图
  for (let i = 0; i < imageFiles.length; i++) {
    const file = imageFiles[i];
    if (!(file instanceof File) || file.size === 0) continue;
    if (file.size > MAX_IMAGE_BYTES) {
      return jsonError('单张图片不能超过 10 MB', 413, request);
    }
    const ext = getImageExtension(file);
    if (!ext) {
      return jsonError('仅支持 PNG、JPG、WEBP、GIF 和 AVIF 图片', 415, request);
    }

    const arrayBuffer = await file.arrayBuffer();
    const base64Data = bufferToBase64(arrayBuffer);

    const lastDot = file.name.lastIndexOf('.');
    const cleanName = sanitizeFilename(lastDot >= 0 ? file.name.substring(0, lastDot) : file.name);
    const targetFilename = `${timeMeta.timestampPrefix}_${i + 1}_${cleanName}${ext}`;
    const repoImagePath = `static/images/moments/${targetFilename}`;
    const webImagePath = `/images/moments/${targetFilename}`;

    filesToCommit.push({
      path: repoImagePath,
      isBinary: true,
      contentBase64: base64Data
    });
    webImagePaths.push(webImagePath);
  }

  // 生成 Front Matter 与 Markdown
  let md = '---\n';
  md += 'title: "动态"\n';
  md += `date: ${timeMeta.isoDate}\n`;
  md += 'draft: false\n';
  md += `author: "${author.replace(/"/g, '\\"')}"\n`;

  if (webImagePaths.length > 0) {
    md += 'images:\n';
    for (const p of webImagePaths) {
      md += `  - "${p}"\n`;
    }
  } else {
    md += 'images: []\n';
  }
  md += '---\n\n';

  // 自动识别正文中独占一行的独立 URL，抓取元数据转换为静态书签卡片 (100% 静态保存到 Markdown)
  const processedContent = await transformStandaloneUrlsToCards(content);
  md += processedContent;
  md += '\n';

  const mdPath = `content/moments/${timeMeta.timestampPrefix}.md`;
  filesToCommit.push({
    path: mdPath,
    isBinary: false,
    content: md
  });

  const commitMsg = `feat(moments): 发布随手记 (${timeMeta.displayDate})`;
  const commitUrl = await commitFilesToGitHub(env, commitMsg, filesToCommit);

  return jsonResponse({
    ok: true,
    commit_url: commitUrl,
    md_path: mdPath,
    images: webImagePaths,
    page_url: `/moment/${timeMeta.timestampPrefix}/`
  });
}

async function handlePublishPost(request, env) {
  const token = extractAuthToken(request);
  const isAuthed = await verifySecret(token, env.ADMIN_SECRET);
  if (!isAuthed) {
    return jsonError('口令未提供或不正确，无权访问', 401);
  }

  if (!validateUploadRequest(request)) {
    return jsonError('上传内容不能超过 32 MB', 413, request);
  }
  const formData = await request.formData();
  const title = (formData.get('title') || '').toString().trim();
  const description = (formData.get('description') || '').toString().trim();
  const rawCategories = (formData.get('categories') || '').toString().trim();
  const rawTags = (formData.get('tags') || '').toString().trim();
  const draft = formData.get('draft') === 'true';
  const content = (formData.get('content') || '').toString().trim();
  const imageFiles = formData.getAll('images');

  if (title.length > 300 || description.length > 2_000 || content.length > MAX_CONTENT_CHARS) {
    return jsonError('标题、摘要或正文长度超出限制', 413, request);
  }

  if (imageFiles.length > MAX_IMAGE_COUNT) {
    return jsonError(`最多上传 ${MAX_IMAGE_COUNT} 张图片`, 413, request);
  }

  if (!title) {
    return jsonError('文章标题不能为空');
  }

  const timeMeta = getChinaTime();
  const filesToCommit = [];

  // 处理文章插图
  for (let i = 0; i < imageFiles.length; i++) {
    const file = imageFiles[i];
    if (!(file instanceof File) || file.size === 0) continue;
    if (file.size > MAX_IMAGE_BYTES) {
      return jsonError('单张图片不能超过 10 MB', 413, request);
    }
    const ext = getImageExtension(file);
    if (!ext) {
      return jsonError('仅支持 PNG、JPG、WEBP、GIF 和 AVIF 图片', 415, request);
    }

    const arrayBuffer = await file.arrayBuffer();
    const base64Data = bufferToBase64(arrayBuffer);

    const lastDot = file.name.lastIndexOf('.');
    const cleanName = sanitizeFilename(lastDot >= 0 ? file.name.substring(0, lastDot) : file.name);
    const targetFilename = `${timeMeta.timestampPrefix}_${i + 1}_${cleanName}${ext}`;
    const repoImagePath = `static/images/${targetFilename}`;

    filesToCommit.push({
      path: repoImagePath,
      isBinary: true,
      contentBase64: base64Data
    });
  }

  // 格式化分类与标签
  const categories = rawCategories ? rawCategories.split(',').map(s => s.trim()).filter(Boolean) : ['技术'];
  const tags = rawTags ? rawTags.split(',').map(s => s.trim()).filter(Boolean) : [];

  // 生成 Front Matter 与 Markdown
  let md = '---\n';
  md += `title: "${title.replace(/"/g, '\\"')}"\n`;
  md += `date: ${timeMeta.isoDate}\n`;
  md += `draft: ${draft}\n`;
  if (description) {
    md += `description: "${description.replace(/"/g, '\\"')}"\n`;
  }
  md += 'categories:\n';
  for (const c of categories) {
    md += `  - "${c.replace(/"/g, '\\"')}"\n`;
  }
  if (tags.length > 0) {
    md += 'tags:\n';
    for (const t of tags) {
      md += `  - "${t.replace(/"/g, '\\"')}"\n`;
    }
  } else {
    md += 'tags: []\n';
  }
  md += '---\n\n';

  // 自动识别正文中独占一行的独立 URL，抓取元数据转换为静态书签卡片 (100% 静态保存到 Markdown)
  const processedContent = await transformStandaloneUrlsToCards(content);
  md += processedContent;
  md += '\n';

  const cleanTitle = sanitizeFilename(title);
  const mdPath = `content/posts/${timeMeta.fileDate}_${cleanTitle}.md`;
  filesToCommit.push({
    path: mdPath,
    isBinary: false,
    content: md
  });

  const commitMsg = draft
    ? `chore(posts): 保存文章草稿《${title}》`
    : `feat(posts): 发布新文章《${title}》`;
  const commitUrl = await commitFilesToGitHub(env, commitMsg, filesToCommit);

  return jsonResponse({
    ok: true,
    commit_url: commitUrl,
    md_path: mdPath,
    title: title
  });
}

// ----------------------------------------------------
// 3.4 辅助工具 (自动识别独占一行的独立 URL，抓取元数据生成 100% 静态书签卡片)
// ----------------------------------------------------

async function fetchUrlMetadata(targetUrl) {
  if (!targetUrl || typeof targetUrl !== 'string') return null;
  targetUrl = targetUrl.trim();
  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = 'https://' + targetUrl;
  }

  let parsedHost = '';
  try {
    parsedHost = new URL(targetUrl).hostname;
  } catch (e) {
    return null;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const resp = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      signal: controller.signal,
      redirect: 'follow'
    });
    if (!resp.ok) {
      return {
        url: targetUrl,
        title: parsedHost,
        desc: '',
        image: '',
        site: parsedHost
      };
    }

    const maxBytes = 150 * 1024;
    if (resp.headers.get('Content-Length') && Number(resp.headers.get('Content-Length')) > maxBytes) {
      return { url: targetUrl, title: parsedHost, desc: '', image: '', site: parsedHost };
    }
    let head = '';
    if (resp.body && typeof resp.body.getReader === 'function') {
      const reader = resp.body.getReader();
      const chunks = [];
      let total = 0;
      while (total < maxBytes) {
        const part = await reader.read();
        if (part.done) break;
        const chunk = part.value;
        const remaining = maxBytes - total;
        const slice = chunk.byteLength > remaining ? chunk.slice(0, remaining) : chunk;
        chunks.push(slice);
        total += slice.byteLength;
        if (slice.byteLength < chunk.byteLength) break;
      }
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      head = new TextDecoder().decode(merged);
    } else {
      head = (await resp.text()).substring(0, maxBytes);
    }
    clearTimeout(timeoutId);

    function getMeta(prop) {
      const regex = new RegExp('<meta[^>]+(?:property|name)=["\']' + prop + '["\'][^>]+content=["\']([^"\']+)["\']', 'i');
      const match = head.match(regex);
      if (match) return match[1];
      const revRegex = new RegExp('<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:property|name)=["\']' + prop + '["\']', 'i');
      const revMatch = head.match(revRegex);
      return revMatch ? revMatch[1] : '';
    }

    let title = getMeta('og:title') || getMeta('twitter:title');
    if (!title) {
      const titleMatch = head.match(/<title[^>]*>([^<]+)<\/title>/i);
      title = titleMatch ? titleMatch[1].trim() : '';
    }

    let desc = getMeta('og:description') || getMeta('description') || getMeta('twitter:description');
    let image = getMeta('og:image') || getMeta('twitter:image');
    let site = getMeta('og:site_name') || parsedHost;

    if (image && !/^https?:\/\//i.test(image)) {
      try {
        image = new URL(image, targetUrl).href;
      } catch {}
    }

    function cleanStr(s) {
      if (!s) return '';
      return s
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
    }

    title = cleanStr(title) || parsedHost;
    desc = cleanStr(desc);
    site = cleanStr(site) || parsedHost;

    return {
      url: targetUrl,
      title,
      desc,
      image: image || '',
      site
    };
  } catch (err) {
    clearTimeout(timeoutId);
    return {
      url: targetUrl,
      title: parsedHost,
      desc: '',
      image: '',
      site: parsedHost
    };
  }
}

// 自动检测正文中独占一行的独立 URL，抓取元数据并转换为静态 Linkcard 短代码
async function transformStandaloneUrlsToCards(content) {
  if (!content || typeof content !== 'string') return content;
  const lines = content.split('\n');
  const urlRegex = /^https?:\/\/[^\s<>"'()]+$/;
  let modified = false;

  const candidates = [];
  for (let i = 0; i < lines.length && candidates.length < 20; i++) {
    const trimmed = lines[i].trim();
    if (urlRegex.test(trimmed)) {
      candidates.push({ index: i, url: trimmed });
    }
  }

  for (let start = 0; start < candidates.length; start += 3) {
    const batch = candidates.slice(start, start + 3);
    await Promise.all(batch.map(async ({ index, url }) => {
      try {
        const meta = await fetchUrlMetadata(url);
        if (!meta) return;
        const esc = s => (s || '').replace(/"/g, '&quot;');
        let card = `{{< linkcard url="${meta.url}" title="${esc(meta.title)}"`;
        if (meta.desc) card += ` desc="${esc(meta.desc)}"`;
        if (meta.site) card += ` site="${esc(meta.site)}"`;
        if (meta.image) card += ` image="${esc(meta.image)}"`;
        card += ' >}}';
        lines[index] = card;
        modified = true;
      } catch (e) {
        console.warn('URL transform failed:', url, e);
      }
    }));
  }

  if (candidates.length >= 20) {
    console.warn('URL transform capped at 20 URLs per document');
  }

  return modified ? lines.join('\n') : content;
}

// ----------------------------------------------------
// 3.5 互动与评论 (Interaction & Comments with Cloudflare D1)
// ----------------------------------------------------

let isDbInit = false;
async function initDatabase(env) {
  if (!env.DB) return false;
  if (isDbInit) return true;
  try {
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS likes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_key TEXT NOT NULL,
        client_ip_hash TEXT NOT NULL,
        ip TEXT,
        ip_location TEXT,
        user_agent TEXT,
        os TEXT,
        browser TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(target_key, client_ip_hash)
      )`),
      env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_likes_target ON likes(target_key)`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS like_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_key TEXT NOT NULL,
        client_ip_hash TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`),
      env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_like_events_client ON like_events(client_ip_hash, created_at)`),
      env.DB.prepare(`CREATE TABLE IF NOT EXISTS comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_key TEXT NOT NULL,
        author TEXT NOT NULL,
        email TEXT,
        avatar TEXT,
        content TEXT NOT NULL,
        ip_hash TEXT,
        ip TEXT,
        ip_location TEXT,
        user_agent TEXT,
        os TEXT,
        browser TEXT,
        status INTEGER DEFAULT 1,
        is_admin INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`),
      env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_comments_target ON comments(target_key, status, created_at)`)
    ]);

    // 自动平滑升级已有数据库表结构 (如已存在字段则捕获忽略)
    const newCols = ['ip', 'ip_location', 'user_agent', 'os', 'browser'];
    for (const col of newCols) {
      try { await env.DB.prepare(`ALTER TABLE comments ADD COLUMN ${col} TEXT`).run(); } catch (err) {
        if (!String(err?.message || err).toLowerCase().includes('duplicate column')) console.error(`Failed to add comments.${col}:`, err);
      }
      try { await env.DB.prepare(`ALTER TABLE likes ADD COLUMN ${col} TEXT`).run(); } catch (err) {
        if (!String(err?.message || err).toLowerCase().includes('duplicate column')) console.error(`Failed to add likes.${col}:`, err);
      }
    }

    // 自动平滑迁移历史动态 target_key (如 moment-20261023030722 -> /moment/2026-10-23-030722/)
    try {
      await env.DB.prepare(`
        UPDATE OR IGNORE likes
        SET target_key = '/moment/' || substr(target_key, 8, 4) || '-' || substr(target_key, 12, 2) || '-' || substr(target_key, 14, 2) || '-' || substr(target_key, 16, 6) || '/'
        WHERE target_key LIKE 'moment-%' AND length(target_key) = 21
      `).run();
      await env.DB.prepare(`
        UPDATE comments
        SET target_key = '/moment/' || substr(target_key, 8, 4) || '-' || substr(target_key, 12, 2) || '-' || substr(target_key, 14, 2) || '-' || substr(target_key, 16, 6) || '/'
        WHERE target_key LIKE 'moment-%' AND length(target_key) = 21
      `).run();
    } catch (err) {
      console.error('Failed to migrate historical interaction keys:', err);
    }

    isDbInit = true;
    return true;
  } catch (err) {
    console.error('Failed to init D1 database:', err);
    return false;
  }
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getIpHash(request) {
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || '127.0.0.1';
  return await sha256Hex(ip + '_blog_interaction_salt');
}

// 解析访客来源客户端元数据 (IP、地理位置、操作系统、浏览器)
function parseClientInfo(request) {
  const ip = request.headers.get('CF-Connecting-IP') ||
             request.headers.get('X-Forwarded-For') ||
             '127.0.0.1';

  const cf = request.cf || {};
  const country = cf.country || '';
  const city = cf.city || '';
  let ipLocation = '';
  if (city && country) {
    ipLocation = country + ' · ' + city;
  } else if (country) {
    ipLocation = country;
  }

  const ua = request.headers.get('User-Agent') || '';

  let os = '其他系统';
  if (/iPhone/i.test(ua)) os = 'iOS (iPhone)';
  else if (/iPad/i.test(ua)) os = 'iPadOS';
  else if (/Macintosh|Mac OS X/i.test(ua)) os = 'macOS';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/Windows NT 10\.0/i.test(ua)) os = 'Windows 10/11';
  else if (/Windows NT 6\.3/i.test(ua)) os = 'Windows 8.1';
  else if (/Windows NT 6\.1/i.test(ua)) os = 'Windows 7';
  else if (/Windows NT/i.test(ua)) os = 'Windows';
  else if (/HarmonyOS/i.test(ua)) os = 'HarmonyOS';
  else if (/Linux/i.test(ua)) os = 'Linux';

  let browser = '其他浏览器';
  if (/MicroMessenger/i.test(ua)) browser = '微信内嵌 (WeChat)';
  else if (/QQBrowser/i.test(ua)) browser = 'QQ 浏览器';
  else if (/Edg/i.test(ua)) browser = 'Edge';
  else if (/Chrome|CriOS/i.test(ua)) browser = 'Chrome';
  else if (/Safari/i.test(ua) && !/Chrome|CriOS/i.test(ua)) browser = 'Safari';
  else if (/Firefox|FxiOS/i.test(ua)) browser = 'Firefox';
  else if (/OPR/i.test(ua)) browser = 'Opera';

  return { ip, ipLocation, os, browser, ua };
}

// URL 安全反转义解码 (escape / percent-encoding -> 可读中文字符)
function safeDecodeURI(str) {
  if (!str || typeof str !== 'string') return '';
  try {
    return decodeURIComponent(str);
  } catch (_) {
    try {
      return decodeURI(str);
    } catch (_) {
      return str;
    }
  }
}

// 规范化目标标识 target_key (兼容旧版 moment-20261023030722 自动转换为 /moment/2026-10-23-030722/)
function normalizeTargetKey(key) {
  if (!key || typeof key !== 'string') return '';
  key = key.trim();
  const m = key.match(/^moment-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (m) {
    return `/moment/${m[1]}-${m[2]}-${m[3]}-${m[4]}${m[5]}${m[6]}/`;
  }
  return key;
}

// ----------------------------------------------------
// 3.6 Bark iOS 实时通知推送 (可选环境变量: BARK_KEY 或 BARK_URL)
// ----------------------------------------------------

async function sendBarkNotification(env, { title, body, group = '博客互动', url = '' }) {
  const rawKey = (env.BARK_KEY || env.BARK_URL || '').trim();
  if (!rawKey) return; // 未配置通知凭据，静默跳过

  let endpoint = rawKey;
  if (!endpoint.startsWith('http://') && !endpoint.startsWith('https://')) {
    endpoint = 'https://api.day.app/' + endpoint;
  }
  endpoint = endpoint.replace(/\/+$/, '');

  const payload = {
    title: title,
    body: body,
    group: group,
    icon: `${getSiteUrl(env)}/favicon.ico`,
    url: url
  };

  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8'
      },
      body: JSON.stringify(payload)
    });
    // 若 POST 异常，自动降级尝试 GET 请求
    if (!resp.ok && resp.status !== 400) {
      const getUrl = `${endpoint}/${encodeURIComponent(title)}/${encodeURIComponent(body)}?group=${encodeURIComponent(group)}&url=${encodeURIComponent(url)}`;
      await fetch(getUrl).catch(() => {});
    }
  } catch (err) {
    console.error('Failed to send Bark notification:', err);
  }
}

async function generateAvatar(email) {
  if (!email || typeof email !== 'string') {
    return 'https://cravatar.cn/avatar/?d=mp';
  }
  const cleanEmail = email.trim().toLowerCase();
  const qqMatch = cleanEmail.match(/^(\d{5,11})@qq\.com$/);
  if (qqMatch) {
    return `https://q1.qlogo.cn/g?b=qq&nk=${qqMatch[1]}&s=100`;
  }
  const hash = await sha256Hex(cleanEmail);
  return `https://cravatar.cn/avatar/${hash}?d=mp`;
}

async function handleGetInteractionsStats(request, env) {
  if (!env.DB) {
    return jsonResponse({ ok: true, stats: {}, message: 'D1 not configured' }, 200, {}, request);
  }
  await initDatabase(env);
  const url = new URL(request.url);
  const keysParam = url.searchParams.get('keys');
  if (!keysParam) {
    return jsonResponse({ ok: true, stats: {} }, 200, {}, request);
  }
  const rawKeys = keysParam.split(',').map(k => k.trim()).filter(Boolean);
  if (rawKeys.length === 0) {
    return jsonResponse({ ok: true, stats: {} }, 200, {}, request);
  }
  const ipHash = await getIpHash(request);

  // 建立 rawKey 与 normalizedKey 的双向映射，兼容新老历史记录
  const keyMap = new Map();
  const queryKeysSet = new Set();
  rawKeys.forEach(rk => {
    const nk = normalizeTargetKey(rk);
    if (!keyMap.has(nk)) keyMap.set(nk, new Set());
    keyMap.get(nk).add(rk);
    queryKeysSet.add(rk);
    queryKeysSet.add(nk);
  });
  const queryKeys = Array.from(queryKeysSet);

  const stats = {};
  rawKeys.forEach(k => {
    stats[k] = { likes: 0, comments: 0, liked: false };
  });

  const placeholders = queryKeys.map(() => '?').join(',');
  const likesStmt = env.DB.prepare(
    `SELECT target_key, COUNT(*) as count FROM likes WHERE target_key IN (${placeholders}) GROUP BY target_key`
  ).bind(...queryKeys);
  const userLikesStmt = env.DB.prepare(
    `SELECT target_key FROM likes WHERE client_ip_hash = ? AND target_key IN (${placeholders})`
  ).bind(ipHash, ...queryKeys);
  const commentsStmt = env.DB.prepare(
    `SELECT target_key, COUNT(*) as count FROM comments WHERE status = 1 AND target_key IN (${placeholders}) GROUP BY target_key`
  ).bind(...queryKeys);

  const [likesRes, userLikesRes, commentsRes] = await env.DB.batch([likesStmt, userLikesStmt, commentsStmt]);

  if (likesRes && likesRes.results) {
    likesRes.results.forEach(row => {
      const matchedRaws = keyMap.get(normalizeTargetKey(row.target_key)) || [row.target_key];
      matchedRaws.forEach(rk => {
        if (stats[rk]) stats[rk].likes = Math.max(stats[rk].likes, row.count || 0);
      });
    });
  }
  if (userLikesRes && userLikesRes.results) {
    userLikesRes.results.forEach(row => {
      const matchedRaws = keyMap.get(normalizeTargetKey(row.target_key)) || [row.target_key];
      matchedRaws.forEach(rk => {
        if (stats[rk]) stats[rk].liked = true;
      });
    });
  }
  if (commentsRes && commentsRes.results) {
    commentsRes.results.forEach(row => {
      const matchedRaws = keyMap.get(normalizeTargetKey(row.target_key)) || [row.target_key];
      matchedRaws.forEach(rk => {
        if (stats[rk]) stats[rk].comments = Math.max(stats[rk].comments, row.count || 0);
      });
    });
  }

  return jsonResponse({ ok: true, stats }, 200, {}, request);
}

async function handleGetInteractionsComments(request, env) {
  if (!env.DB) {
    return jsonResponse({ ok: true, comments: [], message: 'D1 not configured' }, 200, {}, request);
  }
  await initDatabase(env);
  const url = new URL(request.url);
  const rawKey = url.searchParams.get('key');
  if (!rawKey) {
    return jsonError('缺少 key 参数', 400, request);
  }
  const key = normalizeTargetKey(rawKey);
  const requestedLimit = Number(url.searchParams.get('limit') || 100);
  const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 100, 1), 100);
  const after = Number(url.searchParams.get('after') || 0);
  const stmt = after > 0
    ? env.DB.prepare(
      `SELECT id, target_key, author, avatar, content, is_admin, created_at
       FROM comments
       WHERE (target_key = ? OR target_key = ?) AND status = 1 AND id > ?
       ORDER BY id ASC LIMIT ?`
    ).bind(key, rawKey, after, limit)
    : env.DB.prepare(
      `SELECT id, target_key, author, avatar, content, is_admin, created_at
       FROM comments
       WHERE (target_key = ? OR target_key = ?) AND status = 1
       ORDER BY id ASC LIMIT ?`
    ).bind(key, rawKey, limit);
  const { results } = await stmt.all();
  const rows = results || [];
  return jsonResponse({
    ok: true,
    comments: rows,
    has_more: rows.length === limit,
    next_after: rows.length === limit ? rows[rows.length - 1].id : null
  }, 200, {}, request);
}

async function handleInteractionsLike(request, env, ctx) {
  if (!env.DB) {
    return jsonError('数据库未绑定 (D1 DB is not configured)', 500, request);
  }
  await initDatabase(env);
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError('无效的 JSON 请求体', 400, request);
  }
  const { key: rawKey, liked: requestedLiked } = body || {};
  if (!rawKey || typeof rawKey !== 'string') {
    return jsonError('缺少有效的 key 参数', 400, request);
  }
  const key = normalizeTargetKey(rawKey);
  const ipHash = await getIpHash(request);
  const clientInfo = parseClientInfo(request);

  const recentEvent = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM like_events WHERE client_ip_hash = ? AND created_at > datetime('now', '-1 minute')"
  ).bind(ipHash).first();
  if (recentEvent && recentEvent.count >= 10) {
    return jsonError('操作过于频繁，请稍后再试', 429, request);
  }
  await env.DB.prepare('INSERT INTO like_events (target_key, client_ip_hash) VALUES (?, ?)').bind(key, ipHash).run();
  await env.DB.prepare("DELETE FROM like_events WHERE created_at < datetime('now', '-10 minutes')").run();

  let liked;
  if (typeof requestedLiked === 'boolean') {
    liked = requestedLiked;
    if (liked) {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO likes (target_key, client_ip_hash, ip, ip_location, user_agent, os, browser)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(key, ipHash, clientInfo.ip, clientInfo.ipLocation, clientInfo.ua, clientInfo.os, clientInfo.browser).run();
    } else {
      await env.DB.prepare('DELETE FROM likes WHERE (target_key = ? OR target_key = ?) AND client_ip_hash = ?').bind(key, rawKey, ipHash).run();
    }
  } else {
    const existing = await env.DB.prepare('SELECT id FROM likes WHERE (target_key = ? OR target_key = ?) AND client_ip_hash = ?').bind(key, rawKey, ipHash).first();
    liked = !existing;
    if (liked) {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO likes (target_key, client_ip_hash, ip_location, ip, user_agent, os, browser)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(key, ipHash, clientInfo.ipLocation, clientInfo.ip, clientInfo.ua, clientInfo.os, clientInfo.browser).run();
    } else {
      await env.DB.prepare('DELETE FROM likes WHERE (target_key = ? OR target_key = ?) AND client_ip_hash = ?').bind(key, rawKey, ipHash).run();
    }
  }

  const countRow = await env.DB.prepare('SELECT COUNT(*) as count FROM likes WHERE target_key = ? OR target_key = ?').bind(key, rawKey).first();
  const likes = countRow ? countRow.count : 0;

  if (liked) {
    const isMoment = key.startsWith('/moment/');
    const targetLabel = isMoment ? '【动态】' : '【文章】';
    const decodedKey = safeDecodeURI(key);
    const pageUrl = `${getSiteUrl(env)}${key.startsWith('/') ? key : '/' + key}`;

    const title = isMoment
      ? `❤️ 动态收到新点赞: ${decodedKey}`
      : `❤️ 博客文章收到新点赞: ${decodedKey}`;

    const notifyPromise = sendBarkNotification(env, {
      title: title,
      body: `${targetLabel}${key}\n【当前获赞】${likes} 次\n【来源】${clientInfo.ip} (${clientInfo.ipLocation || '未知地区'}) · ${clientInfo.os} · ${clientInfo.browser}`,
      group: '博客互动',
      url: pageUrl
    });
    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(notifyPromise);
    } else {
      notifyPromise.catch(() => {});
    }
  }

  return jsonResponse({ ok: true, likes, liked }, 200, {}, request);
}

async function handleInteractionsComment(request, env, ctx) {
  if (!env.DB) {
    return jsonError('数据库未绑定 (D1 DB is not configured)', 500, request);
  }
  await initDatabase(env);
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError('无效的 JSON 请求体', 400, request);
  }
  const { key: rawKey, author, email, content, hp_token } = body || {};
  if (hp_token) {
    return jsonResponse({ ok: true, comment: { id: 0, author: author || '访客', content: content || '' } }, 200, {}, request);
  }
  if (!rawKey || typeof rawKey !== 'string') {
    return jsonError('目标页面参数无效', 400, request);
  }
  const key = normalizeTargetKey(rawKey);
  const trimmedAuthor = (author || '').trim();
  if (!trimmedAuthor || trimmedAuthor.length > 20) {
    return jsonError('请填写称呼 (1-20字)', 400, request);
  }
  const trimmedContent = (content || '').trim();
  if (!trimmedContent || trimmedContent.length > 500) {
    return jsonError('留言内容请保持在 1-500 字以内', 400, request);
  }

  const ipHash = await getIpHash(request);
  const clientInfo = parseClientInfo(request);

  const recentComment = await env.DB.prepare(
    "SELECT id FROM comments WHERE ip_hash = ? AND created_at > datetime('now', '-20 seconds') LIMIT 1"
  ).bind(ipHash).first();
  if (recentComment) {
    return jsonError('发言过于频繁，请稍息片刻后再试', 429, request);
  }

  let isAdmin = 0;
  let finalAuthor = trimmedAuthor;
  const token = extractAuthToken(request);
  if (token && env.ADMIN_SECRET && (await verifySecret(token, env.ADMIN_SECRET))) {
    isAdmin = 1;
    finalAuthor = trimmedAuthor || env.AUTHOR || '博主';
  }

  const avatar = await generateAvatar(email);

  const insertResult = await env.DB.prepare(
    `INSERT INTO comments (target_key, author, email, avatar, content, ip_hash, ip, ip_location, user_agent, os, browser, status, is_admin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
  ).bind(
    key, finalAuthor, (email || '').trim(), avatar, trimmedContent, ipHash,
    clientInfo.ip, clientInfo.ipLocation, clientInfo.ua, clientInfo.os, clientInfo.browser,
    isAdmin
  ).run();

  const newId = insertResult.meta ? insertResult.meta.last_row_id : null;
  const newComment = {
    id: newId,
    target_key: key,
    author: finalAuthor,
    avatar,
    content: trimmedContent,
    ip: clientInfo.ip,
    ip_location: clientInfo.ipLocation,
    os: clientInfo.os,
    browser: clientInfo.browser,
    is_admin: isAdmin === 1,
    created_at: new Date().toISOString().replace('T', ' ').substring(0, 19)
  };

  const isMoment = key.startsWith('/moment/');
  const targetLabel = isMoment ? '【动态】' : '【文章】';
  const decodedKey = safeDecodeURI(key);
  const pageUrl = `${getSiteUrl(env)}${key.startsWith('/') ? key : '/' + key}`;

  const title = isMoment
    ? `💬 动态新留言: ${decodedKey} (${finalAuthor})`
    : `💬 博客文章新留言: ${decodedKey} (${finalAuthor})`;

  const notifyPromise = sendBarkNotification(env, {
    title: title,
    body: `${targetLabel}${key}\n【内容】${trimmedContent}\n【来源】${clientInfo.ip} (${clientInfo.ipLocation || '未知地区'}) · ${clientInfo.os} · ${clientInfo.browser}`,
    group: '博客互动',
    url: pageUrl
  });
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(notifyPromise);
  } else {
    notifyPromise.catch(() => {});
  }

  return jsonResponse({ ok: true, comment: newComment }, 200, {}, request);
}

async function handleAdminGetComments(request, env) {
  const token = extractAuthToken(request);
  if (!token || !env.ADMIN_SECRET || !(await verifySecret(token, env.ADMIN_SECRET))) {
    return jsonError('口令无效或已过期，请重新登录', 401, request);
  }
  if (!env.DB) {
    return jsonResponse({ ok: true, comments: [], message: 'D1 not configured' }, 200, {}, request);
  }
  await initDatabase(env);
  const stmt = env.DB.prepare(
    `SELECT id, target_key, author, email, avatar, content, ip_hash, ip, ip_location, user_agent, os, browser, status, is_admin, created_at
     FROM comments
     ORDER BY id DESC
     LIMIT 100`
  );
  const { results } = await stmt.all();
  return jsonResponse({ ok: true, comments: results || [] }, 200, {}, request);
}

async function handleAdminGetLikes(request, env) {
  const token = extractAuthToken(request);
  if (!token || !env.ADMIN_SECRET || !(await verifySecret(token, env.ADMIN_SECRET))) {
    return jsonError('口令无效或已过期，请重新登录', 401, request);
  }
  if (!env.DB) {
    return jsonResponse({ ok: true, likes: [], message: 'D1 not configured' }, 200, {}, request);
  }
  await initDatabase(env);
  const stmt = env.DB.prepare(
    `SELECT id, target_key, client_ip_hash, ip, ip_location, user_agent, os, browser, created_at
     FROM likes
     ORDER BY id DESC
     LIMIT 100`
  );
  const { results } = await stmt.all();
  return jsonResponse({ ok: true, likes: results || [] }, 200, {}, request);
}

async function handleAdminDeleteComment(request, env, commentId) {
  const token = extractAuthToken(request);
  if (!token || !env.ADMIN_SECRET || !(await verifySecret(token, env.ADMIN_SECRET))) {
    return jsonError('口令无效或已过期，请重新登录', 401, request);
  }
  if (!env.DB) {
    return jsonError('数据库未绑定', 500, request);
  }
  await initDatabase(env);
  await env.DB.prepare('UPDATE comments SET status = 0 WHERE id = ?').bind(commentId).run();
  return jsonResponse({ ok: true, deleted_id: commentId }, 200, {}, request);
}

// ----------------------------------------------------
// 4. 前端单页嵌入式 UI (HTML + CSS + JS)
// ----------------------------------------------------

const HTML_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>R0n9's Blog Publisher | 博客内容发布台 (Cloudflare Edition)</title>
  <style>
    :root {
      --bg-primary: #f7f7f8;
      --bg-card: #ffffff;
      --bg-input: #ffffff;
      --bg-hover: #f1f3f5;
      --text-primary: #1f2328;
      --text-secondary: #656d76;
      --border-color: #d0d7de;
      --border-focus: #0969da;
      --accent-color: #006cac;
      --accent-hover: #005a91;
      --danger-color: #cf222e;
      --success-color: #1a7f37;
      --code-bg: #f6f8fa;
      --radius-sm: 6px;
      --radius-md: 10px;
      --radius-lg: 14px;
      --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.05);
      --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.08);
      --shadow-lg: 0 10px 25px rgba(0, 0, 0, 0.12);
      --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
    }
    [data-theme="dark"] {
      --bg-primary: #0d1117;
      --bg-card: #161b22;
      --bg-input: #0d1117;
      --bg-hover: #21262d;
      --text-primary: #f0f6fc;
      --text-secondary: #8b949e;
      --border-color: #30363d;
      --border-focus: #58a6ff;
      --accent-color: #388bfd;
      --accent-hover: #1f6feb;
      --danger-color: #f85149;
      --success-color: #3fb950;
      --code-bg: #161b22;
      --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.4);
      --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.5);
      --shadow-lg: 0 10px 25px rgba(0, 0, 0, 0.6);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--font-sans);
      background-color: var(--bg-primary);
      color: var(--text-primary);
      line-height: 1.6;
      min-height: 100vh;
      padding: 24px 16px;
      transition: background-color 0.25s ease, color 0.25s ease;
    }
    .app-container { max-width: 960px; margin: 0 auto; }
    .header {
      display: flex; justify-content: space-between; align-items: center;
      padding: 16px 24px; background-color: var(--bg-card);
      border: 1px solid var(--border-color); border-radius: var(--radius-lg);
      box-shadow: var(--shadow-sm); margin-bottom: 20px;
    }
    .header-brand { display: flex; align-items: center; gap: 14px; }
    .brand-logo {
      font-size: 28px; width: 44px; height: 44px; display: flex;
      align-items: center; justify-content: center;
      background-color: var(--bg-hover); border-radius: var(--radius-md);
    }
    .brand-info h1 { font-size: 1.25rem; font-weight: 700; }
    .brand-subtitle { font-size: 0.8rem; color: var(--text-secondary); font-family: var(--font-mono); }
    .header-actions { display: flex; align-items: center; gap: 10px; }
    .tabs { display: flex; gap: 8px; margin-bottom: 20px; }
    .tab-btn {
      flex: 1; display: flex; align-items: center; justify-content: center;
      gap: 8px; padding: 12px 18px; background-color: var(--bg-card);
      border: 1px solid var(--border-color); color: var(--text-secondary);
      font-size: 0.95rem; font-weight: 600; border-radius: var(--radius-md);
      cursor: pointer; transition: all 0.2s ease;
    }
    .tab-btn:hover { background-color: var(--bg-hover); color: var(--text-primary); }
    .tab-btn.active {
      background-color: var(--accent-color); border-color: var(--accent-color);
      color: #ffffff; box-shadow: var(--shadow-sm);
    }
    .tab-sub { font-size: 0.82rem; font-weight: 400; opacity: 0.85; }
    .tab-content {
      display: none; background-color: var(--bg-card);
      border: 1px solid var(--border-color); border-radius: var(--radius-lg);
      padding: 28px; box-shadow: var(--shadow-sm);
    }
    .tab-content.active { display: block; }
    .publish-form { display: flex; flex-direction: column; gap: 20px; }
    .form-group { display: flex; flex-direction: column; gap: 8px; }
    .form-group label { font-size: 0.9rem; font-weight: 600; color: var(--text-primary); }
    .label-with-toggle { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }
    .checkbox-inline { display: inline-flex; align-items: center; gap: 6px; font-size: 0.82rem; font-weight: 500; color: var(--accent-color); cursor: pointer; user-select: none; }
    .checkbox-inline input[type="checkbox"] { width: 14px; height: 14px; accent-color: var(--accent-color); cursor: pointer; }
    .form-row { display: flex; gap: 16px; flex-wrap: wrap; }
    .col-full { flex: 1 1 100%; }
    .col-half { flex: 1 1 calc(50% - 8px); min-width: 240px; }
    .align-end { display: flex; justify-content: flex-end; align-items: flex-end; }
    input[type="text"], input[type="password"], textarea {
      width: 100%; padding: 10px 14px; font-size: 0.95rem; font-family: inherit;
      background-color: var(--bg-input); color: var(--text-primary);
      border: 1px solid var(--border-color); border-radius: var(--radius-sm); outline: none;
      transition: border-color 0.2s ease, box-shadow 0.2s ease;
    }
    input[type="text"]:focus, input[type="password"]:focus, textarea:focus {
      border-color: var(--border-focus); box-shadow: 0 0 0 3px rgba(9, 105, 218, 0.15);
    }
    textarea { resize: vertical; line-height: 1.5; }
    .checkbox-label { display: flex; align-items: center; gap: 8px; font-size: 0.9rem; cursor: pointer; user-select: none; }
    .checkbox-label input[type="checkbox"] { width: 16px; height: 16px; accent-color: var(--accent-color); }
    .drop-zone {
      border: 2px dashed var(--border-color); border-radius: var(--radius-md);
      padding: 24px 16px; text-align: center; cursor: pointer;
      background-color: var(--bg-hover); transition: all 0.2s ease;
    }
    .drop-zone:hover, .drop-zone.drag-over { border-color: var(--accent-color); background-color: rgba(0, 108, 172, 0.05); }
    .drop-zone-content { display: flex; flex-direction: column; align-items: center; gap: 6px; }
    .upload-icon { font-size: 2rem; }
    .highlight-link { color: var(--accent-color); text-decoration: underline; font-weight: 500; }
    .file-hint { font-size: 0.8rem; color: var(--text-secondary); }
    .file-input-hidden { display: none; }
    .image-preview-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 12px; margin-top: 12px; }
    .image-preview-item {
      position: relative; border-radius: var(--radius-sm); overflow: hidden;
      border: 1px solid var(--border-color); background-color: var(--bg-hover); aspect-ratio: 1;
    }
    .image-preview-item img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .image-preview-item .size-tag {
      position: absolute; top: 6px; left: 6px; background-color: rgba(0, 0, 0, 0.72);
      color: #3fb950; font-size: 0.68rem; font-family: var(--font-mono); font-weight: 600;
      padding: 2px 5px; border-radius: 4px; pointer-events: none; backdrop-filter: blur(2px);
    }
    .image-preview-item .size-tag.normal { color: #f0f6fc; }
    .image-preview-item .remove-btn {
      position: absolute; top: 6px; right: 6px; background-color: rgba(0, 0, 0, 0.65);
      color: #fff; border: none; width: 22px; height: 22px; border-radius: 50%;
      cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 14px;
    }
    .image-preview-item .remove-btn:hover { background-color: var(--danger-color); }
    .image-preview-item .copy-md-btn {
      position: absolute; bottom: 6px; left: 6px; right: 6px;
      background-color: rgba(0, 0, 0, 0.7); color: #fff; border: none; padding: 4px;
      font-size: 0.7rem; border-radius: 4px; cursor: pointer; text-align: center;
    }
    .image-preview-item .copy-md-btn:hover { background-color: var(--accent-color); }
    .editor-container { display: flex; flex-direction: column; }
    .editor-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
    .editor-actions { display: flex; gap: 6px; }
    .editor-split { display: flex; gap: 14px; }
    .editor-pane { flex: 1; }
    .preview-pane {
      flex: 1; border: 1px solid var(--border-color); border-radius: var(--radius-sm);
      background-color: var(--bg-input); display: none; flex-direction: column;
      overflow: hidden; max-height: 480px;
    }
    .preview-pane.visible { display: flex; }
    .preview-header { padding: 8px 12px; font-size: 0.8rem; font-weight: 600; border-bottom: 1px solid var(--border-color); background-color: var(--bg-hover); color: var(--text-secondary); }
    .preview-body { padding: 16px; overflow-y: auto; font-size: 0.95rem; line-height: 1.6; }
    .preview-placeholder { color: var(--text-secondary); font-style: italic; font-size: 0.9rem; }
    .btn {
      display: inline-flex; align-items: center; justify-content: center;
      padding: 9px 16px; font-size: 0.9rem; font-weight: 600; border-radius: var(--radius-sm);
      border: 1px solid transparent; cursor: pointer; transition: all 0.2s ease; text-decoration: none;
    }
    .btn-primary { background-color: var(--accent-color); color: #ffffff; }
    .btn-primary:hover { background-color: var(--accent-hover); }
    .btn-secondary { background-color: var(--bg-hover); color: var(--text-primary); border-color: var(--border-color); }
    .btn-secondary:hover { background-color: var(--border-color); }
    .btn-xs { padding: 4px 8px; font-size: 0.78rem; background-color: var(--bg-hover); color: var(--text-secondary); border-color: var(--border-color); }
    .btn-xs:hover { color: var(--text-primary); border-color: var(--border-focus); }
    .btn-icon { padding: 6px; background: transparent; border: none; font-size: 1.2rem; cursor: pointer; border-radius: var(--radius-sm); }
    .btn-icon:hover { background-color: var(--bg-hover); }
    .btn-block { width: 100%; }
    .btn-publish { padding: 12px 24px; font-size: 1rem; }
    .modal {
      display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      background-color: rgba(0, 0, 0, 0.55); backdrop-filter: blur(4px); z-index: 1000;
      align-items: center; justify-content: center;
    }
    .modal.active { display: flex; }
    .modal-card {
      background-color: var(--bg-card); border-radius: var(--radius-lg);
      border: 1px solid var(--border-color); width: 90%; max-width: 480px;
      padding: 24px; box-shadow: var(--shadow-lg);
    }
    .modal-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
    .modal-close { background: none; border: none; font-size: 1.4rem; color: var(--text-secondary); cursor: pointer; }
    .modal-body { margin-bottom: 20px; display: flex; flex-direction: column; gap: 12px; }
    .modal-footer { display: flex; justify-content: flex-end; gap: 10px; }
    .spinner {
      width: 36px; height: 36px; border: 3px solid var(--border-color);
      border-top-color: var(--accent-color); border-radius: 50%;
      animation: spin 0.8s linear infinite; margin: 12px auto;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .auth-desc { font-size: 0.9rem; color: var(--text-secondary); }
    .auth-error-msg { color: var(--danger-color); font-size: 0.85rem; }
    .markdown-body h1, .markdown-body h2, .markdown-body h3 { margin-top: 14px; margin-bottom: 8px; }
    .markdown-body p { margin-bottom: 10px; }
    .markdown-body pre { background-color: var(--code-bg); padding: 10px; border-radius: 6px; overflow-x: auto; font-family: var(--font-mono); font-size: 0.85rem; margin-bottom: 10px; }
    .markdown-body code { background-color: var(--code-bg); padding: 2px 4px; border-radius: 4px; font-family: var(--font-mono); font-size: 0.88em; }
    .markdown-body img { max-width: 100%; border-radius: 6px; }
    .markdown-body blockquote { border-left: 3px solid var(--accent-color); padding-left: 10px; color: var(--text-secondary); margin-bottom: 10px; }
    .btn-danger { background-color: var(--danger-color); color: #fff; border: 1px solid var(--danger-color); }
    .btn-danger:hover { opacity: 0.9; }
    .admin-comment-card {
      background-color: var(--bg-hover);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 7px;
    }
    .admin-like-card { padding: 9px 12px; gap: 5px; }
    .admin-comment-header { display: flex; align-items: center; gap: 8px; }
    .admin-comment-avatar { width: 26px; height: 26px; border-radius: 50%; object-fit: cover; background: var(--border-color); flex-shrink: 0; }
    .admin-comment-meta { display: flex; align-items: center; gap: 6px; flex: 1; font-size: 0.82rem; flex-wrap: wrap; }
    .admin-comment-author { font-weight: 600; color: var(--text-primary); }
    .admin-comment-target { font-family: var(--font-mono); font-size: 0.72rem; background: var(--bg-card); border: 1px solid var(--border-color); padding: 2px 6px; border-radius: 4px; color: var(--accent-color); max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .admin-comment-time { font-size: 0.72rem; color: var(--text-secondary); margin-left: auto; }
    .admin-comment-body {
      font-size: 0.86rem; line-height: 1.5; color: var(--text-primary); white-space: pre-wrap; word-break: break-word;
      background-color: var(--bg-card); padding: 8px 10px; border-radius: var(--radius-sm); border: 1px solid var(--border-color);
    }
    .admin-comment-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 2px; }
    .subtabs { display: flex; gap: 8px; margin-bottom: 14px; border-bottom: 1px solid var(--border-color); padding-bottom: 8px; }
    .subtab-btn {
      padding: 6px 14px; font-size: 0.84rem; font-weight: 600; border-radius: var(--radius-sm);
      border: 1px solid var(--border-color); background: var(--bg-hover); color: var(--text-secondary);
      cursor: pointer; transition: all 0.2s ease; display: inline-flex; align-items: center; justify-content: center;
    }
    .subtab-btn:hover { color: var(--text-primary); border-color: var(--border-focus); }
    .subtab-btn.active { background: var(--accent-color); border-color: var(--accent-color); color: #ffffff; }
    .client-meta-row { display: flex; flex-wrap: wrap; gap: 5px; margin: 3px 0; }
    .client-meta-badge {
      display: inline-flex; align-items: center; gap: 3px; font-size: 0.73rem;
      padding: 2px 6px; background-color: var(--bg-card); border: 1px solid var(--border-color);
      border-radius: var(--radius-sm); color: var(--text-secondary);
    }
    #admin-comments-list, #admin-likes-list { display: flex; flex-direction: column; gap: 10px; }
    @media (max-width: 640px) {
      body {
        padding: max(10px, env(safe-area-inset-top)) max(10px, env(safe-area-inset-right)) max(20px, env(safe-area-inset-bottom)) max(10px, env(safe-area-inset-left));
      }
      .header {
        padding: 10px 12px; margin-bottom: 12px; border-radius: var(--radius-md);
        flex-direction: row; align-items: center; justify-content: space-between; gap: 8px;
      }
      .brand-logo { font-size: 20px; width: 34px; height: 34px; border-radius: var(--radius-sm); }
      .brand-info h1 { font-size: 1rem; }
      .brand-subtitle { font-size: 0.7rem; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block; }
      .header-actions { width: auto; gap: 6px; }
      .btn-sm { padding: 6px 10px; font-size: 0.78rem; }
      .tabs { gap: 6px; margin-bottom: 14px; overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; }
      .tabs::-webkit-scrollbar { display: none; }
      .tab-btn { padding: 9px 8px; font-size: 0.85rem; white-space: nowrap; flex-shrink: 0; }
      .tab-sub { display: none; }
      .tab-content { padding: 14px 10px; border-radius: var(--radius-md); }
      .publish-form { gap: 14px; }
      input[type="text"], input[type="password"], textarea { font-size: 16px; padding: 9px 12px; }
      .label-with-toggle { flex-direction: column; align-items: flex-start; gap: 6px; }
      .form-row { gap: 12px; }
      .col-half { flex: 1 1 100%; min-width: 100%; }
      .drop-zone { padding: 16px 10px; }
      .upload-icon { font-size: 26px; margin-bottom: 4px; }
      .drop-zone p { font-size: 0.82rem; }
      .file-hint { font-size: 0.72rem; }
      .image-preview-grid { grid-template-columns: repeat(auto-fill, minmax(85px, 1fr)); gap: 8px; }
      .image-preview-thumb { height: 75px; }
      .editor-header { flex-direction: column; align-items: flex-start; gap: 6px; }
      .editor-actions { width: 100%; justify-content: flex-end; gap: 4px; }
      .editor-split { flex-direction: column; gap: 10px; }
      .preview-pane { max-height: 320px; }
      .preview-pane.visible { display: flex; }
      .align-end { width: 100%; justify-content: stretch; }
      .btn-publish { width: 100%; justify-content: center; padding: 12px 16px; font-size: 0.95rem; }
      .modal-card { width: 92%; padding: 20px 14px; border-radius: var(--radius-md); }
      .comments-tab-header { margin-bottom: 12px !important; gap: 8px; }
      .comments-tab-header h2 { font-size: 1rem !important; }
      .comments-tab-header span { font-size: 0.74rem !important; }
      .subtabs { gap: 6px; margin-bottom: 10px; padding-bottom: 6px; }
      .subtab-btn { flex: 1; padding: 7px 4px; font-size: 0.78rem; text-align: center; justify-content: center; }
      .admin-comment-card { padding: 9px 10px; gap: 5px; border-radius: var(--radius-sm); }
      .admin-like-card { padding: 7px 9px; gap: 4px; }
      .admin-comment-avatar { width: 22px; height: 22px; }
      .admin-comment-meta { font-size: 0.74rem; gap: 4px; }
      .admin-comment-author { font-size: 0.78rem; }
      .admin-comment-target { max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.68rem; padding: 1px 4px; }
      .admin-comment-time { font-size: 0.68rem; }
      .admin-comment-body { font-size: 0.82rem; line-height: 1.4; padding: 6px 8px; margin-top: 2px; }
      .client-meta-row { gap: 3px; margin: 2px 0 3px 0; }
      .client-meta-badge { font-size: 0.67rem; padding: 1px 5px; border-radius: 3px; gap: 2px; }
      .admin-comment-actions { margin-top: 2px; }
      .admin-comment-actions .btn-xs { padding: 2px 6px; font-size: 0.72rem; }
      #admin-comments-list, #admin-likes-list { gap: 6px; }
    }
  </style>
</head>
<body>
  <div class="app-container">
    <header class="header">
      <div class="header-brand">
        <div class="brand-logo">⚡</div>
        <div class="brand-info">
          <h1>Blog Publisher</h1>
          <span class="brand-subtitle" id="repo-badge">Cloudflare Edge Edition</span>
        </div>
      </div>
      <div class="header-actions">
        <button id="theme-toggle" class="btn btn-icon" title="切换暗黑/明亮主题">🌓</button>
        <button id="auth-btn" class="btn btn-secondary btn-sm">口令验证</button>
      </div>
    </header>

    <div class="tabs">
      <button class="tab-btn active" data-tab="moment-tab">
        <span class="tab-icon">💬</span> 随手记 <span class="tab-sub">(Moments)</span>
      </button>
      <button class="tab-btn" data-tab="post-tab">
        <span class="tab-icon">📝</span> 长篇文章 <span class="tab-sub">(Posts)</span>
      </button>
      <button class="tab-btn" data-tab="comments-tab">
        <span class="tab-icon">❤️</span> 互动管理 <span class="tab-sub">(Comments)</span>
      </button>
    </div>

    <!-- 随手记发布面板 -->
    <main id="moment-tab" class="tab-content active">
      <form id="moment-form" class="publish-form">
        <div class="form-group">
          <label for="moment-content">动态内容 (支持 Markdown & 原生 Emoji)：</label>
          <textarea id="moment-content" name="content" rows="6" placeholder="今天有什么想记录的？支持直接截图粘贴 (Ctrl+V / Cmd+V)..."></textarea>
        </div>

        <div class="form-group">
          <div class="label-with-toggle">
            <label>配图上传 (支持拖拽、点击选择或直接粘贴)：</label>
            <label class="checkbox-inline">
              <input type="checkbox" id="moment-webp-toggle" checked>
              <span>Canvas 智能压制为 WebP</span>
            </label>
          </div>
          <div class="drop-zone" id="moment-dropzone">
            <input type="file" id="moment-file-input" multiple accept="image/*" class="file-input-hidden">
            <div class="drop-zone-content">
              <span class="upload-icon">📷</span>
              <p>拖拽图片到这里，或 <span class="highlight-link">点击浏览</span>，也可以直接快捷键粘贴图片</p>
              <span class="file-hint">✨ 自动 Canvas 高保真转码 WebP (超大图自动等比缩放至 1920px，体积减少 70%~90%)</span>
            </div>
          </div>
          <div class="image-preview-grid" id="moment-preview-grid"></div>
        </div>

        <div class="form-row">
          <div class="form-group col-half">
            <label for="moment-author">署名 (Author)：</label>
            <input type="text" id="moment-author" name="author" value="R0n9" placeholder="R0n9">
          </div>
          <div class="form-group col-half align-end">
            <button type="submit" class="btn btn-primary btn-publish" id="moment-submit-btn">
              <span>🚀 立即发布随手记</span>
            </button>
          </div>
        </div>
      </form>
    </main>

    <!-- 文章发布面板 -->
    <main id="post-tab" class="tab-content">
      <form id="post-form" class="publish-form">
        <div class="form-row">
          <div class="form-group col-full">
            <label for="post-title">文章标题 *：</label>
            <input type="text" id="post-title" name="title" required placeholder="如：深入探索 Go 内存分配机制">
          </div>
        </div>

        <div class="form-row">
          <div class="form-group col-full">
            <label for="post-description">文章摘要 (Description)：</label>
            <input type="text" id="post-description" name="description" placeholder="一句话总结文章要点，便于首页卡片展示与 SEO">
          </div>
        </div>

        <div class="form-row">
          <div class="form-group col-half">
            <label for="post-categories">分类 (以逗号分隔)：</label>
            <input type="text" id="post-categories" name="categories" value="技术" placeholder="技术, 架构">
          </div>
          <div class="form-group col-half">
            <label for="post-tags">标签 (以逗号分隔)：</label>
            <input type="text" id="post-tags" name="tags" placeholder="Go, 内存管理, 后端">
          </div>
        </div>

        <div class="form-row">
          <div class="form-group draft-group">
            <label class="checkbox-label">
              <input type="checkbox" id="post-draft" name="draft">
              <span>存为草稿 (Draft: true)</span>
            </label>
          </div>
        </div>

        <div class="form-group">
          <div class="label-with-toggle">
            <label>文章配图 / 插图 (上传后将自动提交至 static/images/)：</label>
            <label class="checkbox-inline">
              <input type="checkbox" id="post-webp-toggle" checked>
              <span>Canvas 智能压制为 WebP</span>
            </label>
          </div>
          <div class="drop-zone" id="post-dropzone">
            <input type="file" id="post-file-input" multiple accept="image/*" class="file-input-hidden">
            <div class="drop-zone-content">
              <span class="upload-icon">🖼️</span>
              <p>拖拽插图到此，或 <span class="highlight-link">选择插图</span>。上传后可一键复制 Markdown 引用链接</p>
              <span class="file-hint">✨ 自动转换为 WebP 格式，大幅节省仓库容量与文章访问加载时间</span>
            </div>
          </div>
          <div class="image-preview-grid" id="post-preview-grid"></div>
        </div>

        <div class="form-group editor-container">
          <div class="editor-header">
            <label for="post-content">正文内容 (Markdown)：</label>
            <div class="editor-actions">
              <button type="button" class="btn btn-xs" id="insert-code-btn">代码块</button>
              <button type="button" class="btn btn-xs" id="insert-table-btn">表格</button>
              <button type="button" class="btn btn-xs" id="toggle-preview-btn">切换双栏实时预览</button>
            </div>
          </div>
          <div class="editor-split" id="editor-split-wrapper">
            <div class="editor-pane">
              <textarea id="post-content" name="content" rows="16" placeholder="# 标题一&#10;&#10;开始写正文... 支持直接拖拽或粘贴图片插入到光标处"></textarea>
            </div>
            <div class="preview-pane" id="post-preview-pane">
              <div class="preview-header">实时渲染预览</div>
              <div class="preview-body markdown-body" id="post-preview-body">
                <p class="preview-placeholder">在此输入 Markdown，右侧将实时渲染预览效果...</p>
              </div>
            </div>
          </div>
        </div>

        <div class="form-row">
          <div class="form-group col-full align-end">
            <button type="submit" class="btn btn-primary btn-publish" id="post-submit-btn">
              <span>🚀 发布文章至 GitHub</span>
            </button>
          </div>
        </div>
      </form>
    </main>

    <!-- 互动管理面板 -->
    <main id="comments-tab" class="tab-content">
      <div class="comments-tab-header" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
        <div>
          <h2 style="font-size:1.05rem; font-weight:700; margin:0 0 2px 0;">💬 访客留言与点赞管理</h2>
          <span style="font-size:0.78rem; color:var(--text-secondary);">全站留言与点赞明细，记录 IP、地区与设备系统</span>
        </div>
        <button type="button" class="btn btn-secondary btn-sm" id="refresh-comments-btn">🔄 刷新</button>
      </div>

      <div class="subtabs">
        <button type="button" class="subtab-btn active" id="subtab-comments-btn">💬 访客留言 (<span id="comments-count">0</span>)</button>
        <button type="button" class="subtab-btn" id="subtab-likes-btn">❤️ 点赞记录 (<span id="likes-count">0</span>)</button>
      </div>

      <div id="admin-comments-container">
        <div id="admin-comments-loading" style="text-align:center; padding:32px; color:var(--text-secondary); font-size:0.9rem;">
          点击“刷新数据”或切换标签载入最新留言...
        </div>
        <div id="admin-comments-list" style="display:flex; flex-direction:column; gap:12px;"></div>
      </div>

      <div id="admin-likes-container" style="display:none;">
        <div id="admin-likes-loading" style="text-align:center; padding:32px; color:var(--text-secondary); font-size:0.9rem;">
          正在载入最新点赞记录...
        </div>
        <div id="admin-likes-list" style="display:flex; flex-direction:column; gap:12px;"></div>
      </div>
    </main>

    <!-- 结果通知模态框 -->
    <div id="status-modal" class="modal">
      <div class="modal-card">
        <div class="modal-header">
          <h3 id="modal-title">正在发布...</h3>
          <button class="modal-close" id="modal-close-btn">&times;</button>
        </div>
        <div class="modal-body" id="modal-body">
          <div class="spinner" id="modal-spinner"></div>
          <p id="modal-message">正在打包数据并生成 GitHub 提交...</p>
        </div>
        <div class="modal-footer" id="modal-footer">
          <button class="btn btn-secondary" id="modal-dismiss-btn">关闭</button>
          <a href="#" target="_blank" class="btn btn-primary" id="modal-commit-link" style="display:none;">查看 GitHub Commit</a>
        </div>
      </div>
    </div>

    <!-- 口令认证模态框 -->
    <div id="auth-modal" class="modal">
      <div class="modal-card">
        <div class="modal-header">
          <h3>管理口令验证</h3>
        </div>
        <div class="modal-body">
          <p class="auth-desc">请输入在 Cloudflare Worker 配置的 <code>ADMIN_SECRET</code> 口令以解锁发布权限：</p>
          <div class="form-group">
            <input type="password" id="secret-input" placeholder="输入访问口令..." autocomplete="current-password">
          </div>
          <p class="auth-error-msg" id="auth-error" style="display:none;"></p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-primary btn-block" id="secret-submit-btn">验证并保存</button>
        </div>
      </div>
    </div>
  </div>

  <script>
    (function () {
      'use strict';
      let adminSecret = localStorage.getItem('r0n9_admin_secret') || '';
      let activeTab = 'moment-tab';
      let momentImages = [];
      let postImages = [];

      const repoBadge = document.getElementById('repo-badge');
      const themeToggle = document.getElementById('theme-toggle');
      const authBtn = document.getElementById('auth-btn');
      const authModal = document.getElementById('auth-modal');
      const secretInput = document.getElementById('secret-input');
      const secretSubmitBtn = document.getElementById('secret-submit-btn');
      const authError = document.getElementById('auth-error');

      const tabButtons = document.querySelectorAll('.tab-btn');
      const tabContents = document.querySelectorAll('.tab-content');

      const momentForm = document.getElementById('moment-form');
      const momentContent = document.getElementById('moment-content');
      const momentAuthor = document.getElementById('moment-author');
      const momentDropzone = document.getElementById('moment-dropzone');
      const momentFileInput = document.getElementById('moment-file-input');
      const momentPreviewGrid = document.getElementById('moment-preview-grid');
      const momentSubmitBtn = document.getElementById('moment-submit-btn');
      const momentWebpToggle = document.getElementById('moment-webp-toggle');

      const postForm = document.getElementById('post-form');
      const postTitle = document.getElementById('post-title');
      const postDescription = document.getElementById('post-description');
      const postCategories = document.getElementById('post-categories');
      const postTags = document.getElementById('post-tags');
      const postDraft = document.getElementById('post-draft');
      const postContent = document.getElementById('post-content');
      const postDropzone = document.getElementById('post-dropzone');
      const postFileInput = document.getElementById('post-file-input');
      const postPreviewGrid = document.getElementById('post-preview-grid');
      const postSubmitBtn = document.getElementById('post-submit-btn');
      const postWebpToggle = document.getElementById('post-webp-toggle');
      const togglePreviewBtn = document.getElementById('toggle-preview-btn');
      const previewPane = document.getElementById('post-preview-pane');
      const previewBody = document.getElementById('post-preview-body');

      const statusModal = document.getElementById('status-modal');
      const modalTitle = document.getElementById('modal-title');
      const modalSpinner = document.getElementById('modal-spinner');
      const modalMessage = document.getElementById('modal-message');
      const modalCommitLink = document.getElementById('modal-commit-link');
      const modalCloseBtn = document.getElementById('modal-close-btn');
      const modalDismissBtn = document.getElementById('modal-dismiss-btn');

      function initTheme() {
        const savedTheme = localStorage.getItem('r0n9_theme');
        const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        if (savedTheme === 'dark' || (!savedTheme && prefersDark)) {
          document.documentElement.setAttribute('data-theme', 'dark');
        } else {
          document.documentElement.removeAttribute('data-theme');
        }
      }

      themeToggle.addEventListener('click', () => {
        const current = document.documentElement.getAttribute('data-theme');
        if (current === 'dark') {
          document.documentElement.removeAttribute('data-theme');
          localStorage.setItem('r0n9_theme', 'light');
        } else {
          document.documentElement.setAttribute('data-theme', 'dark');
          localStorage.setItem('r0n9_theme', 'dark');
        }
      });

      async function verifySecret(secret) {
        try {
          const resp = await fetch('/api/auth/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ secret: secret })
          });
          const data = await resp.json();
          if (resp.ok && data.ok) {
            adminSecret = secret;
            localStorage.setItem('r0n9_admin_secret', secret);
            repoBadge.textContent = \`\${data.repo} (\${data.branch})\`;
            repoBadge.style.color = 'var(--success-color)';
            authBtn.textContent = '已连接';
            authBtn.classList.remove('btn-secondary');
            authBtn.classList.add('btn-primary');
            authModal.classList.remove('active');
            if (data.author && momentAuthor) {
              momentAuthor.value = data.author;
            }
            return true;
          } else {
            throw new Error(data.error || '口令错误');
          }
        } catch (err) {
          repoBadge.textContent = '未连接 (需口令)';
          repoBadge.style.color = 'var(--danger-color)';
          authBtn.textContent = '口令验证';
          authBtn.classList.remove('btn-primary');
          authBtn.classList.add('btn-secondary');
          return false;
        }
      }

      authBtn.addEventListener('click', () => {
        secretInput.value = adminSecret;
        authError.style.display = 'none';
        authModal.classList.add('active');
        secretInput.focus();
      });

      secretSubmitBtn.addEventListener('click', async () => {
        const val = secretInput.value.trim();
        if (!val) {
          authError.textContent = '请输入口令';
          authError.style.display = 'block';
          return;
        }
        secretSubmitBtn.disabled = true;
        secretSubmitBtn.textContent = '验证中...';
        authError.style.display = 'none';
        const success = await verifySecret(val);
        secretSubmitBtn.disabled = false;
        secretSubmitBtn.textContent = '验证并保存';
        if (!success) {
          authError.textContent = '口令无效，请重新输入';
          authError.style.display = 'block';
        }
      });

      secretInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          secretSubmitBtn.click();
        }
      });

      tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
          tabButtons.forEach(b => b.classList.remove('active'));
          tabContents.forEach(c => c.classList.remove('active'));
          btn.classList.add('active');
          activeTab = btn.getAttribute('data-tab');
          document.getElementById(activeTab).classList.add('active');
          if (activeTab === 'comments-tab') {
            if (currentInteractionTab === 'comments') {
              loadAdminComments();
            } else {
              loadAdminLikes();
            }
          }
        });
      });

      let currentInteractionTab = 'comments';
      const subtabCommentsBtn = document.getElementById('subtab-comments-btn');
      const subtabLikesBtn = document.getElementById('subtab-likes-btn');
      const commentsContainer = document.getElementById('admin-comments-container');
      const likesContainer = document.getElementById('admin-likes-container');

      if (subtabCommentsBtn && subtabLikesBtn) {
        subtabCommentsBtn.addEventListener('click', () => {
          currentInteractionTab = 'comments';
          subtabCommentsBtn.classList.add('active');
          subtabLikesBtn.classList.remove('active');
          commentsContainer.style.display = 'block';
          likesContainer.style.display = 'none';
          loadAdminComments();
        });

        subtabLikesBtn.addEventListener('click', () => {
          currentInteractionTab = 'likes';
          subtabLikesBtn.classList.add('active');
          subtabCommentsBtn.classList.remove('active');
          likesContainer.style.display = 'block';
          commentsContainer.style.display = 'none';
          loadAdminLikes();
        });
      }

      async function loadAdminComments() {
        const loadingEl = document.getElementById('admin-comments-loading');
        const listEl = document.getElementById('admin-comments-list');
        const countEl = document.getElementById('comments-count');
        loadingEl.style.display = 'block';
        loadingEl.textContent = '正在获取最新留言...';
        listEl.innerHTML = '';

        try {
          const res = await fetch('/api/admin/comments', {
            headers: { 'Authorization': 'Bearer ' + adminSecret }
          });
          const data = await res.json();
          loadingEl.style.display = 'none';

          if (!data.ok) {
            loadingEl.style.display = 'block';
            loadingEl.textContent = '获取失败: ' + (data.error || '未知错误');
            return;
          }

          const comments = data.comments || [];
          if (countEl) countEl.textContent = comments.length;

          if (comments.length === 0) {
            loadingEl.style.display = 'block';
            loadingEl.textContent = '暂无访客留言 (DB 连接正常)';
            return;
          }

          comments.forEach(c => {
            const card = document.createElement('div');
            card.className = 'admin-comment-card';
            card.id = 'admin-comment-' + c.id;
            const isHidden = c.status === 0;

            const adminBadge = c.is_admin ? '<span style="font-size:0.7rem; background:var(--accent-color); color:#fff; padding:1px 5px; border-radius:3px;">博主</span>' : '';
            const emailTag = c.email ? '<span style="font-size:0.75rem; color:var(--text-secondary);">&lt;' + escapeHtml(c.email) + '&gt;</span>' : '';
            const actionBtn = !isHidden ? '<button type="button" class="btn btn-xs btn-danger delete-comment-btn" data-id="' + c.id + '">🗑️ 删除</button>' : '<span style="font-size:0.75rem; color:var(--text-secondary);">已隐藏/删除</span>';
            const bodyStyle = isHidden ? 'text-decoration:line-through; opacity:0.6;' : '';

            const ipBadge = c.ip ? '<span class="client-meta-badge" title="访客 IP">🌐 ' + escapeHtml(c.ip) + (c.ip_location ? ' · ' + escapeHtml(c.ip_location) : '') + '</span>' : '';
            const osBadge = c.os ? '<span class="client-meta-badge" title="操作系统">💻 ' + escapeHtml(c.os) + '</span>' : '';
            const browserBadge = c.browser ? '<span class="client-meta-badge" title="浏览器">🧭 ' + escapeHtml(c.browser) + '</span>' : '';
            const metaRow = (ipBadge || osBadge || browserBadge) ? '<div class="client-meta-row">' + ipBadge + osBadge + browserBadge + '</div>' : '';

            const decodedTarget = safeDecodeURI(c.target_key);
            const targetUrl = c.target_key.startsWith('/') ? ('https://r0n9.github.io' + c.target_key) : ('https://r0n9.github.io/' + c.target_key);
            const targetLink = '<a href="' + escapeHtml(targetUrl) + '" target="_blank" rel="noopener" class="admin-comment-target" title="新窗口打开: ' + escapeHtml(decodedTarget) + '">' + escapeHtml(decodedTarget) + ' ↗</a>';

            card.innerHTML =
              '<div class="admin-comment-header">' +
                '<img src="' + escapeHtml(c.avatar || '') + '" class="admin-comment-avatar" alt="avatar" onerror="this.onerror=null;this.src=&apos;https://cravatar.cn/avatar/?d=mp&apos;;"/>' +
                '<div class="admin-comment-meta">' +
                  '<span class="admin-comment-author">' + escapeHtml(c.author) + '</span>' +
                  adminBadge +
                  targetLink +
                  emailTag +
                  '<span class="admin-comment-time">' + escapeHtml(c.created_at || '') + '</span>' +
                '</div>' +
              '</div>' +
              metaRow +
              '<div class="admin-comment-body" style="' + bodyStyle + '">' +
                escapeHtml(c.content) +
              '</div>' +
              '<div class="admin-comment-actions">' +
                actionBtn +
              '</div>';
            listEl.appendChild(card);
          });

          listEl.querySelectorAll('.delete-comment-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
              const id = btn.getAttribute('data-id');
              if (!confirm('确定要删除此条留言吗？')) return;
              btn.disabled = true;
              try {
                const delRes = await fetch('/api/admin/comments/' + id, {
                  method: 'DELETE',
                  headers: { 'Authorization': 'Bearer ' + adminSecret }
                });
                const delData = await delRes.json();
                if (delData.ok) {
                  const card = document.getElementById('admin-comment-' + id);
                  if (card) {
                    card.style.opacity = '0.5';
                    btn.parentNode.innerHTML = '<span style="font-size:0.75rem; color:var(--text-secondary);">已删除</span>';
                  }
                } else {
                  alert('删除失败: ' + (delData.error || '未知错误'));
                  btn.disabled = false;
                }
              } catch (err) {
                alert('网络异常: ' + err.message);
                btn.disabled = false;
              }
            });
          });
        } catch (err) {
          loadingEl.style.display = 'block';
          loadingEl.textContent = '请求异常: ' + err.message;
        }
      }

      async function loadAdminLikes() {
        const loadingEl = document.getElementById('admin-likes-loading');
        const listEl = document.getElementById('admin-likes-list');
        const countEl = document.getElementById('likes-count');
        loadingEl.style.display = 'block';
        loadingEl.textContent = '正在获取最新点赞...';
        listEl.innerHTML = '';

        try {
          const res = await fetch('/api/admin/likes', {
            headers: { 'Authorization': 'Bearer ' + adminSecret }
          });
          const data = await res.json();
          loadingEl.style.display = 'none';

          if (!data.ok) {
            loadingEl.style.display = 'block';
            loadingEl.textContent = '获取失败: ' + (data.error || '未知错误');
            return;
          }

          const likes = data.likes || [];
          if (countEl) countEl.textContent = likes.length;

          if (likes.length === 0) {
            loadingEl.style.display = 'block';
            loadingEl.textContent = '暂无访客点赞记录 (DB 连接正常)';
            return;
          }

          likes.forEach(l => {
            const card = document.createElement('div');
            card.className = 'admin-comment-card admin-like-card';

            const ipBadge = l.ip ? '<span class="client-meta-badge" title="访客 IP">🌐 ' + escapeHtml(l.ip) + (l.ip_location ? ' · ' + escapeHtml(l.ip_location) : '') + '</span>' : '';
            const osBadge = l.os ? '<span class="client-meta-badge" title="操作系统">💻 ' + escapeHtml(l.os) + '</span>' : '';
            const browserBadge = l.browser ? '<span class="client-meta-badge" title="浏览器">🧭 ' + escapeHtml(l.browser) + '</span>' : '';
            const metaRow = (ipBadge || osBadge || browserBadge) ? '<div class="client-meta-row">' + ipBadge + osBadge + browserBadge + '</div>' : '<div class="client-meta-row"><span class="client-meta-badge" style="opacity:0.6;">无来源详情</span></div>';

            const decodedTarget = safeDecodeURI(l.target_key);
            const targetUrl = l.target_key.startsWith('/') ? ('https://r0n9.github.io' + l.target_key) : ('https://r0n9.github.io/' + l.target_key);
            const targetLink = '<a href="' + escapeHtml(targetUrl) + '" target="_blank" rel="noopener" class="admin-comment-target" title="新窗口打开: ' + escapeHtml(decodedTarget) + '">' + escapeHtml(decodedTarget) + ' ↗</a>';

            card.innerHTML =
              '<div class="admin-comment-header">' +
                '<div style="width:22px; height:22px; border-radius:50%; background:rgba(207,34,46,0.12); display:flex; align-items:center; justify-content:center; font-size:0.8rem; flex-shrink:0;">❤️</div>' +
                '<div class="admin-comment-meta">' +
                  '<span class="admin-comment-author" style="color:var(--danger-color);">访客点赞</span>' +
                  targetLink +
                  '<span class="admin-comment-time">' + escapeHtml(l.created_at || '') + '</span>' +
                '</div>' +
              '</div>' +
              metaRow;
            listEl.appendChild(card);
          });
        } catch (err) {
          loadingEl.style.display = 'block';
          loadingEl.textContent = '请求异常: ' + err.message;
        }
      }

      const refreshCommentsBtn = document.getElementById('refresh-comments-btn');
      if (refreshCommentsBtn) {
        refreshCommentsBtn.addEventListener('click', () => {
          if (currentInteractionTab === 'comments') {
            loadAdminComments();
          } else {
            loadAdminLikes();
          }
        });
      }

      function formatFileSize(bytes) {
        if (!bytes || bytes < 1024) return (bytes || 0) + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
      }

      async function processImage(file, enableWebP = true, maxDimension = 1920, quality = 0.85) {
        if (!enableWebP || file.type === 'image/gif') {
          file._meta = { origSize: file.size, compressedSize: file.size, ratio: 0 };
          return file;
        }

        return new Promise((resolve) => {
          const img = new Image();
          const objectUrl = URL.createObjectURL(file);

          img.onload = () => {
            URL.revokeObjectURL(objectUrl);
            let width = img.naturalWidth;
            let height = img.naturalHeight;

            if (width > maxDimension || height > maxDimension) {
              if (width > height) {
                height = Math.round((height * maxDimension) / width);
                width = maxDimension;
              } else {
                width = Math.round((width * maxDimension) / height);
                height = maxDimension;
              }
            }

            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;

            const ctx = canvas.getContext('2d');
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(img, 0, 0, width, height);

            canvas.toBlob((blob) => {
              if (!blob) {
                file._meta = { origSize: file.size, compressedSize: file.size, ratio: 0 };
                resolve(file);
                return;
              }

              const lastDot = file.name.lastIndexOf('.');
              const baseName = lastDot !== -1 ? file.name.substring(0, lastDot) : file.name;
              const newName = \`\${baseName}.webp\`;
              const webpFile = new File([blob], newName, { type: 'image/webp' });

              const ratio = file.size > blob.size ? Math.round(((file.size - blob.size) / file.size) * 100) : 0;
              webpFile._meta = {
                origSize: file.size,
                compressedSize: blob.size,
                ratio: ratio
              };

              resolve(webpFile);
            }, 'image/webp', quality);
          };

          img.onerror = () => {
            URL.revokeObjectURL(objectUrl);
            file._meta = { origSize: file.size, compressedSize: file.size, ratio: 0 };
            resolve(file);
          };

          img.src = objectUrl;
        });
      }

      function renderPreviews(files, container, isPost = false) {
        container.innerHTML = '';
        files.forEach((file, index) => {
          const item = document.createElement('div');
          item.className = 'image-preview-item';

          const img = document.createElement('img');
          img.src = URL.createObjectURL(file);
          item.appendChild(img);

          const sizeTag = document.createElement('span');
          if (file._meta && file._meta.ratio > 0) {
            sizeTag.className = 'size-tag';
            sizeTag.textContent = \`\${formatFileSize(file.size)} (-\${file._meta.ratio}%)\`;
            sizeTag.title = \`原始: \${formatFileSize(file._meta.origSize)} -> WebP: \${formatFileSize(file.size)}\`;
          } else {
            sizeTag.className = 'size-tag normal';
            sizeTag.textContent = formatFileSize(file.size);
          }
          item.appendChild(sizeTag);

          const removeBtn = document.createElement('button');
          removeBtn.className = 'remove-btn';
          removeBtn.innerHTML = '&times;';
          removeBtn.title = '移除图片';
          removeBtn.type = 'button';
          removeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            files.splice(index, 1);
            renderPreviews(files, container, isPost);
          });
          item.appendChild(removeBtn);

          if (isPost) {
            const copyBtn = document.createElement('button');
            copyBtn.className = 'copy-md-btn';
            copyBtn.type = 'button';
            copyBtn.textContent = '插入文中';
            copyBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              insertMarkdownAtCursor(postContent, \`\\n![\${file.name}](/images/\${file.name})\\n\`);
              renderMarkdownPreview();
            });
            item.appendChild(copyBtn);
          }

          container.appendChild(item);
        });
      }

      function setupDropzone(dropzone, fileInput, filesArray, previewGrid, toggleCheckbox, isPost = false) {
        dropzone.addEventListener('click', () => fileInput.click());
        dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag-over'); });
        dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));

        async function handleIncomingFiles(fileList) {
          const enableWebP = toggleCheckbox ? toggleCheckbox.checked : true;
          for (const f of fileList) {
            if (f.type.startsWith('image/')) {
              const processed = await processImage(f, enableWebP);
              filesArray.push(processed);
            }
          }
          renderPreviews(filesArray, previewGrid, isPost);
        }

        dropzone.addEventListener('drop', async (e) => {
          e.preventDefault();
          dropzone.classList.remove('drag-over');
          if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            await handleIncomingFiles(e.dataTransfer.files);
          }
        });

        fileInput.addEventListener('change', async () => {
          if (fileInput.files && fileInput.files.length > 0) {
            await handleIncomingFiles(fileInput.files);
            fileInput.value = '';
          }
        });
      }

      setupDropzone(momentDropzone, momentFileInput, momentImages, momentPreviewGrid, momentWebpToggle, false);
      setupDropzone(postDropzone, postFileInput, postImages, postPreviewGrid, postWebpToggle, true);

      window.addEventListener('paste', async (e) => {
        const clipboardData = e.clipboardData;
        if (!clipboardData || !clipboardData.items) return;

        for (let i = 0; i < clipboardData.items.length; i++) {
          const item = clipboardData.items[i];
          if (item.type.indexOf('image') !== -1) {
            const blob = item.getAsFile();
            const ext = blob.type.split('/')[1] || 'png';
            const rawFilename = \`paste_\${Date.now()}.\${ext}\`;
            const rawFile = new File([blob], rawFilename, { type: blob.type });

            if (activeTab === 'moment-tab') {
              const enableWebP = momentWebpToggle ? momentWebpToggle.checked : true;
              const processed = await processImage(rawFile, enableWebP);
              momentImages.push(processed);
              renderPreviews(momentImages, momentPreviewGrid, false);
            } else {
              const enableWebP = postWebpToggle ? postWebpToggle.checked : true;
              const processed = await processImage(rawFile, enableWebP);
              postImages.push(processed);
              renderPreviews(postImages, postPreviewGrid, true);
              if (document.activeElement === postContent) {
                insertMarkdownAtCursor(postContent, \`\\n![插图](/images/\${processed.name})\\n\`);
                renderMarkdownPreview();
              }
            }
          }
        }
      });

      function insertMarkdownAtCursor(textarea, textToInsert) {
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const value = textarea.value;
        textarea.value = value.substring(0, start) + textToInsert + value.substring(end);
        textarea.selectionStart = textarea.selectionEnd = start + textToInsert.length;
        textarea.focus();
      }

      function escapeHtml(text) {
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      }

      function safeDecodeURI(str) {
        if (!str || typeof str !== 'string') return '';
        try { return decodeURIComponent(str); } catch (_) {
          try { return decodeURI(str); } catch (_) { return str; }
        }
      }

      function simpleMarkdownToHtml(md) {
        if (!md) return '<p class="preview-placeholder">在此输入 Markdown，右侧将实时渲染预览效果...</p>';
        let lines = md.split('\\n');
        let html = '';
        let inCodeBlock = false;

        for (let i = 0; i < lines.length; i++) {
          let line = lines[i];
          if (line.startsWith('\`\`\`')) {
            if (!inCodeBlock) {
              inCodeBlock = true;
              html += '<pre><code>';
            } else {
              inCodeBlock = false;
              html += '</code></pre>\\n';
            }
            continue;
          }
          if (inCodeBlock) {
            html += escapeHtml(line) + '\\n';
            continue;
          }
          if (line.startsWith('### ')) { html += \`<h3>\${escapeHtml(line.slice(4))}</h3>\\n\`; continue; }
          if (line.startsWith('## ')) { html += \`<h2>\${escapeHtml(line.slice(3))}</h2>\\n\`; continue; }
          if (line.startsWith('# ')) { html += \`<h1>\${escapeHtml(line.slice(2))}</h1>\\n\`; continue; }
          if (line.startsWith('> ')) { html += \`<blockquote>\${escapeHtml(line.slice(2))}</blockquote>\\n\`; continue; }
          if (line.trim() === '') continue;

          let formatted = escapeHtml(line);
          formatted = formatted.replace(/!\\[([^\\]]*)\\]\\(([^)]+)\\)/g, '<img src="$2" alt="$1">');
          formatted = formatted.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
          formatted = formatted.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
          formatted = formatted.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
          html += \`<p>\${formatted}</p>\\n\`;
        }
        if (inCodeBlock) html += '</code></pre>\\n';
        return html;
      }

      function renderMarkdownPreview() {
        if (previewPane.classList.contains('visible')) {
          previewBody.innerHTML = simpleMarkdownToHtml(postContent.value);
        }
      }

      postContent.addEventListener('input', renderMarkdownPreview);
      togglePreviewBtn.addEventListener('click', () => {
        previewPane.classList.toggle('visible');
        renderMarkdownPreview();
      });

      document.getElementById('insert-code-btn').addEventListener('click', () => {
        insertMarkdownAtCursor(postContent, '\\n\`\`\`bash\\n\\n\`\`\`\\n');
        renderMarkdownPreview();
      });

      document.getElementById('insert-table-btn').addEventListener('click', () => {
        insertMarkdownAtCursor(postContent, '\\n| 列名 1 | 列名 2 |\\n| :--- | :--- |\\n| 单元格 1 | 单元格 2 |\\n');
        renderMarkdownPreview();
      });

      function showStatusModal(title, msg, isPending = true) {
        modalTitle.textContent = title;
        modalMessage.textContent = msg;
        modalSpinner.style.display = isPending ? 'block' : 'none';
        modalCommitLink.style.display = 'none';
        statusModal.classList.add('active');
      }

      function setStatusSuccess(title, msg, commitUrl) {
        modalTitle.textContent = title;
        modalMessage.innerHTML = msg;
        modalSpinner.style.display = 'none';
        if (commitUrl) {
          modalCommitLink.href = commitUrl;
          modalCommitLink.style.display = 'inline-flex';
        }
      }

      function setStatusError(title, err) {
        modalTitle.textContent = title;
        modalMessage.innerHTML = \`<span style="color:var(--danger-color);font-weight:600;">错误：</span> \${escapeHtml(err)}\`;
        modalSpinner.style.display = 'none';
      }

      modalCloseBtn.addEventListener('click', () => statusModal.classList.remove('active'));
      modalDismissBtn.addEventListener('click', () => statusModal.classList.remove('active'));

      momentForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!adminSecret) { authBtn.click(); return; }

        const contentVal = momentContent.value.trim();
        if (!contentVal && momentImages.length === 0) {
          alert('请填写动态内容或上传配图');
          return;
        }

        showStatusModal('正在发布随手记...', '正在打包 Markdown 内容与配图...');
        momentSubmitBtn.disabled = true;

        try {
          const formData = new FormData();
          formData.append('content', contentVal);
          formData.append('author', momentAuthor.value.trim() || 'R0n9');
          for (const img of momentImages) {
            formData.append('images', img);
          }

          const resp = await fetch('/api/publish/moment', {
            method: 'POST',
            headers: { 'Authorization': \`Bearer \${adminSecret}\` },
            body: formData
          });

          const res = await resp.json();
          if (!resp.ok || !res.ok) throw new Error(res.error || '发布失败');

          setStatusSuccess(
            '🎉 动态发布成功！',
            \`已生成 Markdown 并提交到 GitHub。<br>文件路径: <code>\${escapeHtml(res.md_path)}</code>\`,
            res.commit_url
          );
          momentContent.value = '';
          momentImages = [];
          momentPreviewGrid.innerHTML = '';
        } catch (err) {
          setStatusError('发布动态失败', err.message);
        } finally {
          momentSubmitBtn.disabled = false;
        }
      });

      postForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!adminSecret) { authBtn.click(); return; }

        const titleVal = postTitle.value.trim();
        if (!titleVal) { alert('请填写文章标题'); return; }

        showStatusModal('正在发布文章...', '正在调用 GitHub Git Data API 提交文章与插图...');
        postSubmitBtn.disabled = true;

        try {
          const formData = new FormData();
          formData.append('title', titleVal);
          formData.append('description', postDescription.value.trim());
          formData.append('categories', postCategories.value.trim());
          formData.append('tags', postTags.value.trim());
          formData.append('draft', postDraft.checked ? 'true' : 'false');
          formData.append('content', postContent.value.trim());
          for (const img of postImages) {
            formData.append('images', img);
          }

          const resp = await fetch('/api/publish/post', {
            method: 'POST',
            headers: { 'Authorization': \`Bearer \${adminSecret}\` },
            body: formData
          });

          const res = await resp.json();
          if (!resp.ok || !res.ok) throw new Error(res.error || '发布文章失败');

          const draftNotice = postDraft.checked ? ' (草稿模式)' : '';
          setStatusSuccess(
            \`🎉 文章发布成功！\${draftNotice}\`,
            \`文章《\${escapeHtml(res.title)}》已成功提交！<br>文件路径: <code>\${escapeHtml(res.md_path)}</code>\`,
            res.commit_url
          );
          postTitle.value = '';
          postDescription.value = '';
          postTags.value = '';
          postContent.value = '';
          postDraft.checked = false;
          postImages = [];
          postPreviewGrid.innerHTML = '';
          renderMarkdownPreview();
        } catch (err) {
          setStatusError('发布文章失败', err.message);
        } finally {
          postSubmitBtn.disabled = false;
        }
      });

      initTheme();
      if (adminSecret) {
        verifySecret(adminSecret);
      } else {
        authModal.classList.add('active');
        setTimeout(() => { if (secretInput && secretInput.focus) secretInput.focus(); }, 100);
      }
    })();
  </script>
</body>
</html>`;

// ----------------------------------------------------
// 5. Worker 主入口导出
// ----------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 跨域预检请求 (CORS Preflight)
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request)
      });
    }

    // 静态前端界面 (自适应感应：未配置 D1 时自动隐藏互动管理标签，保持纯净发布形态)
    if (path === '/' || path === '/index.html') {
      const hasD1 = Boolean(env.DB);
      let pageHtml = HTML_PAGE.replaceAll('https://r0n9.github.io', getSiteUrl(env));
      if (!hasD1) {
        pageHtml = pageHtml.replace('data-tab="comments-tab"', 'data-tab="comments-tab" style="display:none;"');
      }
      return new Response(pageHtml, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache, no-store, must-revalidate'
        }
      });
    }

    // API 路由分发
    try {
      // 1. 公开互动 API
      if (path === '/api/interactions/stats' && request.method === 'GET') {
        return await handleGetInteractionsStats(request, env);
      }
      if (path === '/api/interactions/comments' && request.method === 'GET') {
        return await handleGetInteractionsComments(request, env);
      }
      if (path === '/api/interactions/like' && request.method === 'POST') {
        return await handleInteractionsLike(request, env, ctx);
      }
      if (path === '/api/interactions/comment' && request.method === 'POST') {
        return await handleInteractionsComment(request, env, ctx);
      }

      // 2. 管理员互动管理 API
      if (path === '/api/admin/comments' && request.method === 'GET') {
        return await handleAdminGetComments(request, env);
      }
      if (path === '/api/admin/likes' && request.method === 'GET') {
        return await handleAdminGetLikes(request, env);
      }
      const deleteMatch = path.match(/^\/api\/admin\/comments\/(\d+)$/);
      if (deleteMatch && request.method === 'DELETE') {
        return await handleAdminDeleteComment(request, env, deleteMatch[1]);
      }

      // 3. 发布与管理 API
      if (path === '/api/auth/verify' && request.method === 'POST') {
        return await handleAuthVerify(request, env);
      }
      if (path === '/api/publish/moment' && request.method === 'POST') {
        return await handlePublishMoment(request, env);
      }
      if (path === '/api/publish/post' && request.method === 'POST') {
        return await handlePublishPost(request, env);
      }
    } catch (err) {
      return jsonError(err.message || '服务器内部异常', 500, request);
    }

    return new Response('Not Found', {
      status: 404,
      headers: corsHeaders(request)
    });
  }
};
