/**
 * R0n9's Blog Publisher - Cloudflare Worker Edition
 * 极简、免服务器、零运维的边缘博客在线发布服务
 * 
 * 环境变量 (通过 Cloudflare 控制台或 wrangler secret 设置)：
 * - GITHUB_TOKEN: 具备仓库 Contents 写入权限的 GitHub 访问令牌 (Secret)
 * - ADMIN_SECRET: Web 页面访问与发布管理口令 (Secret)
 * - GITHUB_REPO: 目标仓库 (如 "r0n9/r0n9.github.io")
 * - GITHUB_BRANCH: 分支名 (默认 "master")
 * - AUTHOR: 默认署名作者 (默认 "R0n9")
 */

// ----------------------------------------------------
// 1. 工具辅助函数
// ----------------------------------------------------

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...headers
    }
  });
}

function jsonError(message, status = 400) {
  return jsonResponse({ ok: false, error: message }, status);
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
      return match[1].trim();
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
    'Set-Cookie': `admin_secret=${encodeURIComponent(body.secret)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`
  });
}

async function handlePublishMoment(request, env) {
  const token = extractAuthToken(request);
  const isAuthed = await verifySecret(token, env.ADMIN_SECRET);
  if (!isAuthed) {
    return jsonError('口令未提供或不正确，无权访问', 401);
  }

  const formData = await request.formData();
  const content = (formData.get('content') || '').toString().trim();
  const author = (formData.get('author') || env.AUTHOR || 'R0n9').toString().trim();
  const imageFiles = formData.getAll('images');

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

    const arrayBuffer = await file.arrayBuffer();
    const base64Data = bufferToBase64(arrayBuffer);

    let ext = '.png';
    const lastDot = file.name.lastIndexOf('.');
    if (lastDot !== -1) {
      ext = file.name.substring(lastDot);
    }
    const cleanName = sanitizeFilename(file.name.substring(0, lastDot !== -1 ? lastDot : undefined));
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
  md += content;
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
    page_url: `/moments/#moment-${timeMeta.momentHash}`
  });
}

async function handlePublishPost(request, env) {
  const token = extractAuthToken(request);
  const isAuthed = await verifySecret(token, env.ADMIN_SECRET);
  if (!isAuthed) {
    return jsonError('口令未提供或不正确，无权访问', 401);
  }

  const formData = await request.formData();
  const title = (formData.get('title') || '').toString().trim();
  const description = (formData.get('description') || '').toString().trim();
  const rawCategories = (formData.get('categories') || '').toString().trim();
  const rawTags = (formData.get('tags') || '').toString().trim();
  const draft = formData.get('draft') === 'true';
  const content = (formData.get('content') || '').toString().trim();
  const imageFiles = formData.getAll('images');

  if (!title) {
    return jsonError('文章标题不能为空');
  }

  const timeMeta = getChinaTime();
  const filesToCommit = [];

  // 处理文章插图
  for (let i = 0; i < imageFiles.length; i++) {
    const file = imageFiles[i];
    if (!(file instanceof File) || file.size === 0) continue;

    const arrayBuffer = await file.arrayBuffer();
    const base64Data = bufferToBase64(arrayBuffer);

    let ext = '.png';
    const lastDot = file.name.lastIndexOf('.');
    if (lastDot !== -1) {
      ext = file.name.substring(lastDot);
    }
    const cleanName = sanitizeFilename(file.name.substring(0, lastDot !== -1 ? lastDot : undefined));
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
  md += content;
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
// 4. 前端单页嵌入式 UI (HTML + CSS + JS)
// ----------------------------------------------------

const HTML_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
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
    @media (max-width: 640px) {
      body { padding: 12px 8px; }
      .header { flex-direction: column; align-items: flex-start; gap: 12px; }
      .header-actions { width: 100%; justify-content: flex-end; }
      .editor-split { flex-direction: column; }
      .preview-pane { display: none !important; }
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
        <span class="tab-icon">💬</span> 随手记 (Moments)
      </button>
      <button class="tab-btn" data-tab="post-tab">
        <span class="tab-icon">📝</span> 长篇文章 (Posts)
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

      tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
          tabButtons.forEach(b => b.classList.remove('active'));
          tabContents.forEach(c => c.classList.remove('active'));
          btn.classList.add('active');
          activeTab = btn.getAttribute('data-tab');
          document.getElementById(activeTab).classList.add('active');
        });
      });

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

    // 静态前端界面
    if (path === '/' || path === '/index.html') {
      return new Response(HTML_PAGE, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache, no-store, must-revalidate'
        }
      });
    }

    // API 路由分发
    try {
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
      return jsonError(err.message || '服务器内部异常', 500);
    }

    return new Response('Not Found', { status: 404 });
  }
};
