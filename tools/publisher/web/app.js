(function () {
  'use strict';

  // --- 状态管理 ---
  let adminSecret = localStorage.getItem('r0n9_admin_secret') || '';
  let activeTab = 'moment-tab';
  let momentImages = [];
  let postImages = [];

  // --- DOM 元素引用 ---
  const repoBadge = document.getElementById('repo-badge');
  const themeToggle = document.getElementById('theme-toggle');
  const authBtn = document.getElementById('auth-btn');
  const authModal = document.getElementById('auth-modal');
  const secretInput = document.getElementById('secret-input');
  const secretSubmitBtn = document.getElementById('secret-submit-btn');
  const authError = document.getElementById('auth-error');

  const tabButtons = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');

  // Moments 元素
  const momentForm = document.getElementById('moment-form');
  const momentContent = document.getElementById('moment-content');
  const momentAuthor = document.getElementById('moment-author');
  const momentDropzone = document.getElementById('moment-dropzone');
  const momentFileInput = document.getElementById('moment-file-input');
  const momentPreviewGrid = document.getElementById('moment-preview-grid');
  const momentSubmitBtn = document.getElementById('moment-submit-btn');
  const momentWebpToggle = document.getElementById('moment-webp-toggle');

  // Posts 元素
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

  // 状态模态框
  const statusModal = document.getElementById('status-modal');
  const modalTitle = document.getElementById('modal-title');
  const modalSpinner = document.getElementById('modal-spinner');
  const modalMessage = document.getElementById('modal-message');
  const modalCommitLink = document.getElementById('modal-commit-link');
  const modalCloseBtn = document.getElementById('modal-close-btn');
  const modalDismissBtn = document.getElementById('modal-dismiss-btn');

  // --- 主题切换 ---
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

  // --- 身份验证逻辑 ---
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
        repoBadge.textContent = `${data.repo} (${data.branch})`;
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

  // --- 选项卡切换 ---
  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      tabButtons.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      activeTab = btn.getAttribute('data-tab');
      document.getElementById(activeTab).classList.add('active');
    });
  });

  // --- 格式化文件大小 ---
  function formatFileSize(bytes) {
    if (!bytes || bytes < 1024) return (bytes || 0) + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  // --- Canvas 图像智能压制与 WebP 转码 ---
  async function processImage(file, enableWebP = true, maxDimension = 1920, quality = 0.85) {
    // GIF 动图不通过 Canvas 处理，避免丢失多帧动画
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

        // 如果超出最大尺寸，等比例平滑缩小
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

          // 构造 WebP 文件名
          const lastDot = file.name.lastIndexOf('.');
          const baseName = lastDot !== -1 ? file.name.substring(0, lastDot) : file.name;
          const newName = `${baseName}.webp`;
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

  // --- 图片处理通用辅助函数 ---
  function renderPreviews(files, container, isPost = false) {
    container.innerHTML = '';
    files.forEach((file, index) => {
      const item = document.createElement('div');
      item.className = 'image-preview-item';

      const img = document.createElement('img');
      img.src = URL.createObjectURL(file);
      item.appendChild(img);

      // 大小与压缩比标签
      const sizeTag = document.createElement('span');
      if (file._meta && file._meta.ratio > 0) {
        sizeTag.className = 'size-tag';
        sizeTag.textContent = `${formatFileSize(file.size)} (-${file._meta.ratio}%)`;
        sizeTag.title = `原始大小: ${formatFileSize(file._meta.origSize)} -> WebP: ${formatFileSize(file.size)}`;
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
          insertMarkdownAtCursor(postContent, `\n![${file.name}](/images/${file.name})\n`);
          renderMarkdownPreview();
        });
        item.appendChild(copyBtn);
      }

      container.appendChild(item);
    });
  }

  function setupDropzone(dropzone, fileInput, filesArray, previewGrid, toggleCheckbox, isPost = false) {
    dropzone.addEventListener('click', () => fileInput.click());

    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('drag-over');
    });

    dropzone.addEventListener('dragleave', () => {
      dropzone.classList.remove('drag-over');
    });

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

  // --- 全局及输入框剪贴板图片粘贴 (Ctrl+V / Cmd+V) ---
  window.addEventListener('paste', async (e) => {
    const clipboardData = e.clipboardData;
    if (!clipboardData || !clipboardData.items) return;

    for (let i = 0; i < clipboardData.items.length; i++) {
      const item = clipboardData.items[i];
      if (item.type.indexOf('image') !== -1) {
        const blob = item.getAsFile();
        const ext = blob.type.split('/')[1] || 'png';
        const rawFilename = `paste_${Date.now()}.${ext}`;
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
            insertMarkdownAtCursor(postContent, `\n![插图](/images/${processed.name})\n`);
            renderMarkdownPreview();
          }
        }
      }
    }
  });

  // --- Markdown 辅助工具与简单实时预览渲染 ---
  function insertMarkdownAtCursor(textarea, textToInsert) {
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const value = textarea.value;
    textarea.value = value.substring(0, start) + textToInsert + value.substring(end);
    textarea.selectionStart = textarea.selectionEnd = start + textToInsert.length;
    textarea.focus();
  }

  function escapeHtml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // 轻量级自包含 Markdown 解析器 (零外部依赖，100% 离线支持)
  function simpleMarkdownToHtml(md) {
    if (!md) return '<p class="preview-placeholder">在此输入 Markdown，右侧将实时渲染预览效果...</p>';

    let lines = md.split('\n');
    let html = '';
    let inCodeBlock = false;
    let codeBlockLang = '';

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];

      // 代码块检测
      if (line.startsWith('```')) {
        if (!inCodeBlock) {
          inCodeBlock = true;
          codeBlockLang = line.slice(3).trim();
          html += '<pre><code>';
        } else {
          inCodeBlock = false;
          html += '</code></pre>\n';
        }
        continue;
      }

      if (inCodeBlock) {
        html += escapeHtml(line) + '\n';
        continue;
      }

      // 标题检测
      if (line.startsWith('### ')) {
        html += `<h3>${escapeHtml(line.slice(4))}</h3>\n`;
        continue;
      }
      if (line.startsWith('## ')) {
        html += `<h2>${escapeHtml(line.slice(3))}</h2>\n`;
        continue;
      }
      if (line.startsWith('# ')) {
        html += `<h1>${escapeHtml(line.slice(2))}</h1>\n`;
        continue;
      }

      // 引用块
      if (line.startsWith('> ')) {
        html += `<blockquote>${escapeHtml(line.slice(2))}</blockquote>\n`;
        continue;
      }

      // 空行
      if (line.trim() === '') {
        continue;
      }

      // 行内解析：加粗、行内代码、图片、链接
      let formatted = escapeHtml(line);
      // 图片: ![alt](url)
      formatted = formatted.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">');
      // 链接: [text](url)
      formatted = formatted.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
      // 行内代码: `code`
      formatted = formatted.replace(/`([^`]+)`/g, '<code>$1</code>');
      // 加粗: **bold**
      formatted = formatted.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

      html += `<p>${formatted}</p>\n`;
    }

    if (inCodeBlock) {
      html += '</code></pre>\n';
    }

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
    insertMarkdownAtCursor(postContent, '\n```bash\n\n```\n');
    renderMarkdownPreview();
  });

  document.getElementById('insert-table-btn').addEventListener('click', () => {
    insertMarkdownAtCursor(postContent, '\n| 列名 1 | 列名 2 |\n| :--- | :--- |\n| 单元格 1 | 单元格 2 |\n');
    renderMarkdownPreview();
  });

  // --- 模态框控制 ---
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
    modalMessage.innerHTML = `<span style="color:var(--danger-color);font-weight:600;">错误：</span> ${escapeHtml(err)}`;
    modalSpinner.style.display = 'none';
  }

  modalCloseBtn.addEventListener('click', () => statusModal.classList.remove('active'));
  modalDismissBtn.addEventListener('click', () => statusModal.classList.remove('active'));

  // --- 表单提交：随手记 (Moments) ---
  momentForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (!adminSecret) {
      authBtn.click();
      return;
    }

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
        headers: {
          'Authorization': `Bearer ${adminSecret}`
        },
        body: formData
      });

      const res = await resp.json();
      if (!resp.ok || !res.ok) {
        throw new Error(res.error || '发布失败');
      }

      setStatusSuccess(
        '🎉 动态发布成功！',
        `已生成 Markdown 并提交到 GitHub。<br>文件路径: <code>${escapeHtml(res.md_path)}</code>`,
        res.commit_url
      );

      // 重置表单
      momentContent.value = '';
      momentImages = [];
      momentPreviewGrid.innerHTML = '';
    } catch (err) {
      setStatusError('发布动态失败', err.message);
    } finally {
      momentSubmitBtn.disabled = false;
    }
  });

  // --- 表单提交：长篇文章 (Posts) ---
  postForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (!adminSecret) {
      authBtn.click();
      return;
    }

    const titleVal = postTitle.value.trim();
    if (!titleVal) {
      alert('请填写文章标题');
      return;
    }

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
        headers: {
          'Authorization': `Bearer ${adminSecret}`
        },
        body: formData
      });

      const res = await resp.json();
      if (!resp.ok || !res.ok) {
        throw new Error(res.error || '发布文章失败');
      }

      const draftNotice = postDraft.checked ? ' (草稿模式)' : '';
      setStatusSuccess(
        `🎉 文章发布成功！${draftNotice}`,
        `文章《${escapeHtml(res.title)}》已成功提交！<br>文件路径: <code>${escapeHtml(res.md_path)}</code>`,
        res.commit_url
      );

      // 重置表单
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

  // --- 初始化启动流程 ---
  initTheme();
  if (adminSecret) {
    verifySecret(adminSecret);
  } else {
    authModal.classList.add('active');
    setTimeout(() => { if (secretInput && secretInput.focus) secretInput.focus(); }, 100);
  }
})();
