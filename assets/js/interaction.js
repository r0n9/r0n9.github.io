/**
 * R0n9's Blog Interaction Client (Vanilla JS < 3KB)
 * 极致轻量、免登录的互动系统客户端 (点赞 + 纸质留言板)
 */
(function() {
  'use strict';

  var API_BASE = (window.__INTERACTION_API__ || '').replace(/\/+$/, '');
  if (!API_BASE) {
    return;
  }
  var STORAGE_PREFIX = 'blog_liked_';
  var AUTHOR_KEY = 'blog_comment_author';
  var EMAIL_KEY = 'blog_comment_email';

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatTime(timeStr) {
    if (!timeStr) return '';
    var date = new Date(timeStr);
    if (isNaN(date.getTime())) return timeStr;
    var y = date.getFullYear();
    var m = String(date.getMonth() + 1).padStart(2, '0');
    var d = String(date.getDate()).padStart(2, '0');
    var hh = String(date.getHours()).padStart(2, '0');
    var mm = String(date.getMinutes()).padStart(2, '0');
    return y + '/' + m + '/' + d + ' ' + hh + ':' + mm;
  }

  // 1. 批量拉取统计数据
  var fetchedKeys = new Set();
  function fetchStatsBatch(keys) {
    var toFetch = keys.filter(function(k) { return k && !fetchedKeys.has(k); });
    if (toFetch.length === 0) return;
    toFetch.forEach(function(k) { fetchedKeys.add(k); });

    // 检查本地已点赞状态
    toFetch.forEach(function(key) {
      if (localStorage.getItem(STORAGE_PREFIX + key)) {
        var actionEls = document.querySelectorAll('[data-key="' + CSS.escape(key) + '"]');
        actionEls.forEach(function(wrap) {
          var likeBtn = wrap.querySelector('.moment-like-btn, .post-like-btn');
          if (likeBtn) likeBtn.classList.add('liked');
        });
      }
    });

    if (!API_BASE) return;

    fetch(API_BASE + '/api/interactions/stats?keys=' + encodeURIComponent(toFetch.join(',')))
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (!data || !data.ok || !data.stats) return;
        Object.keys(data.stats).forEach(function(key) {
          var stat = data.stats[key];
          var wraps = document.querySelectorAll('[data-key="' + CSS.escape(key) + '"]');
          wraps.forEach(function(wrap) {
            var likeCountEl = wrap.querySelector('.like-count, #postLikeCount');
            if (likeCountEl && typeof stat.likes === 'number') {
              likeCountEl.textContent = stat.likes;
            }
            var commentCountEl = wrap.querySelector('.comment-count');
            if (commentCountEl && typeof stat.comments === 'number') {
              commentCountEl.textContent = stat.comments;
            }
            var commentBadgeEl = wrap.querySelector('#postCommentsBadge');
            if (commentBadgeEl && typeof stat.comments === 'number') {
              commentBadgeEl.textContent = '(' + stat.comments + ')';
            }
            if (stat.liked) {
              var likeBtn = wrap.querySelector('.moment-like-btn, .post-like-btn');
              if (likeBtn) {
                likeBtn.classList.add('liked');
                localStorage.setItem(STORAGE_PREFIX + key, '1');
              }
            }
          });
        });
      })
      .catch(function(err) {
        toFetch.forEach(function(k) { fetchedKeys.delete(k); });
        console.warn('[interaction] stats fetch failed:', err);
      });
  }

  // 收集当前 DOM 中所有 key
  function scanAndFetchStats() {
    var keyEls = document.querySelectorAll('[data-key]');
    var keys = [];
    keyEls.forEach(function(el) {
      var k = el.getAttribute('data-key');
      if (k) keys.push(k);
    });
    if (keys.length > 0) {
      fetchStatsBatch(keys);
    }
  }

  // 2. 点赞处理
  function handleLikeClick(btn) {
    var wrap = btn.closest('[data-key]');
    if (!wrap) return;
    var key = wrap.getAttribute('data-key');
    if (!key) return;

    if (!API_BASE) {
      alert('互动功能需要先在 hugo.yaml 中配置 interactionApi 服务地址');
      return;
    }

    var isLiked = btn.classList.contains('liked');
    var countEl = wrap.querySelector('.like-count, #postLikeCount');
    var currentCount = parseInt(countEl ? countEl.textContent : '0', 10) || 0;
    var previousLiked = isLiked;
    var previousCount = currentCount;

    // 乐观 UI 更新
    if (isLiked) {
      btn.classList.remove('liked');
      if (countEl) countEl.textContent = Math.max(0, currentCount - 1);
      localStorage.removeItem(STORAGE_PREFIX + key);
    } else {
      btn.classList.add('liked');
      if (countEl) countEl.textContent = currentCount + 1;
      localStorage.setItem(STORAGE_PREFIX + key, '1');
    }

    btn.disabled = true;

    fetch(API_BASE + '/api/interactions/like', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: key, liked: !isLiked })
    })
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (!data || !data.ok) {
          throw new Error((data && data.error) || '点赞请求失败');
        }
        if (countEl && typeof data.likes === 'number') {
          countEl.textContent = data.likes;
        }
        if (data.liked) {
          btn.classList.add('liked');
          localStorage.setItem(STORAGE_PREFIX + key, '1');
        } else {
          btn.classList.remove('liked');
          localStorage.removeItem(STORAGE_PREFIX + key);
        }
      })
      .catch(function(err) {
        if (previousLiked) {
          btn.classList.add('liked');
          localStorage.setItem(STORAGE_PREFIX + key, '1');
        } else {
          btn.classList.remove('liked');
          localStorage.removeItem(STORAGE_PREFIX + key);
        }
        if (countEl) countEl.textContent = previousCount;
        console.error('[interaction] like error:', err);
      })
      .finally(function() {
        btn.disabled = false;
      });
  }

  // 3. 渲染单条评论 HTML
  function renderCommentItem(c) {
    var adminBadge = c.is_admin ? '<span class="comment-badge-admin">博主</span>' : '';
    var safeAvatar = escapeHtml(c.avatar || 'https://cravatar.cn/avatar/?d=mp');
    var safeAuthor = escapeHtml(c.author || '访客');
    var safeTime = formatTime(c.created_at);
    var safeContent = escapeHtml(c.content).replace(/\n/g, '<br/>');

    return (
      '<div class="comment-item" id="comment-' + c.id + '">' +
        '<img class="comment-avatar" src="' + safeAvatar + '" alt="' + safeAuthor + '" loading="lazy" onerror="this.src=\'https://cravatar.cn/avatar/?d=mp\'"/>' +
        '<div class="comment-main">' +
          '<div class="comment-meta">' +
            '<strong class="comment-author">' + safeAuthor + '</strong>' +
            adminBadge +
            '<time class="comment-time">' + safeTime + '</time>' +
          '</div>' +
          '<div class="comment-content">' + safeContent + '</div>' +
        '</div>' +
      '</div>'
    );
  }

  // 4. 拉取某目标的评论列表
  function loadComments(key, listContainer) {
    if (!API_BASE) {
      listContainer.innerHTML = '<div class="comments-notice">未配置 interactionApi，暂无法加载留言</div>';
      return;
    }

    listContainer.innerHTML = '<div class="comments-loading">正在加载留言...</div>';

    fetch(API_BASE + '/api/interactions/comments?key=' + encodeURIComponent(key))
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (!data || !data.ok) {
          listContainer.innerHTML = '<div class="comments-notice error">加载失败: ' + escapeHtml((data && data.error) || '未知异常') + '</div>';
          return;
        }
        if (!data.comments || data.comments.length === 0) {
          listContainer.innerHTML = '<div class="comments-empty-notice">暂无留言，写下第一条想法吧~</div>';
          return;
        }
        var html = data.comments.map(renderCommentItem).join('');
        listContainer.innerHTML = html;
      })
      .catch(function(err) {
        listContainer.innerHTML = '<div class="comments-notice error">网络异常，无法连接评论服务</div>';
      });
  }

  // 5. 提交评论逻辑
  function setupCommentForm(form, key, listContainer, countCallback) {
    // 恢复本地保存的昵称与邮箱
    var authorInput = form.querySelector('input[name="author"]');
    var emailInput = form.querySelector('input[name="email"]');
    var contentInput = form.querySelector('textarea[name="content"]');
    var submitBtn = form.querySelector('.comment-submit-btn');
    var feedbackEl = form.querySelector('.form-feedback');

    if (authorInput) authorInput.value = localStorage.getItem(AUTHOR_KEY) || '';
    if (emailInput) emailInput.value = localStorage.getItem(EMAIL_KEY) || '';

    form.addEventListener('submit', function(e) {
      e.preventDefault();
      if (!API_BASE) {
        alert('请在 hugo.yaml 中配置 interactionApi 后发表留言');
        return;
      }

      var hp = form.querySelector('input[name="hp_token"]').value;
      var author = authorInput ? authorInput.value.trim() : '';
      var email = emailInput ? emailInput.value.trim() : '';
      var content = contentInput ? contentInput.value.trim() : '';

      if (!author) {
        alert('请填写称呼');
        if (authorInput) authorInput.focus();
        return;
      }
      if (!content) {
        alert('请输入留言内容');
        if (contentInput) contentInput.focus();
        return;
      }

      // 本地存储访客信息
      localStorage.setItem(AUTHOR_KEY, author);
      if (email) {
        localStorage.setItem(EMAIL_KEY, email);
      }

      var textEl = submitBtn ? (submitBtn.querySelector('.btn-text') || submitBtn) : null;
      if (submitBtn) {
        submitBtn.disabled = true;
        if (textEl) textEl.textContent = '发送中...';
      }
      if (feedbackEl) {
        feedbackEl.style.display = 'none';
        feedbackEl.className = 'form-feedback';
      }

      fetch(API_BASE + '/api/interactions/comment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: key,
          author: author,
          email: email,
          content: content,
          hp_token: hp
        })
      })
        .then(function(res) { return res.json(); })
        .then(function(data) {
          if (submitBtn) {
            submitBtn.disabled = false;
            if (textEl) textEl.textContent = '发送';
          }
          if (data && data.ok && data.comment) {
            // 清理并渲染
            if (contentInput) contentInput.value = '';
            var emptyNotice = listContainer.querySelector('.comments-empty-notice');
            if (emptyNotice) emptyNotice.remove();

            var newCommentHtml = renderCommentItem(data.comment);
            listContainer.insertAdjacentHTML('beforeend', newCommentHtml);

            if (feedbackEl) {
              feedbackEl.textContent = '留言发表成功！';
              feedbackEl.classList.add('success');
              feedbackEl.style.display = 'block';
              setTimeout(function() { feedbackEl.style.display = 'none'; }, 3000);
            }

            if (typeof countCallback === 'function') {
              countCallback(1);
            }
          } else {
            var errMsg = (data && data.error) || '提交留言失败';
            if (feedbackEl) {
              feedbackEl.textContent = errMsg;
              feedbackEl.classList.add('error');
              feedbackEl.style.display = 'block';
            } else {
              alert(errMsg);
            }
          }
        })
        .catch(function(err) {
          if (submitBtn) {
            submitBtn.disabled = false;
            if (textEl) textEl.textContent = '发送';
          }
          if (feedbackEl) {
            feedbackEl.textContent = '网络错误: ' + err.message;
            feedbackEl.classList.add('error');
            feedbackEl.style.display = 'block';
          } else {
            alert('网络异常: ' + err.message);
          }
        });
    });
  }

  // 6. 初始化页面互动组件
  function initInteractions() {
    // 文章页 (Posts)
    var postWrap = document.getElementById('postInteractionWrap');
    if (postWrap) {
      var postKey = postWrap.getAttribute('data-key');
      var postLikeBtn = document.getElementById('postLikeBtn');
      if (postLikeBtn) {
        postLikeBtn.addEventListener('click', function() {
          handleLikeClick(postLikeBtn);
        });
      }

      var postCommentBtn = postWrap.querySelector('.post-comment-btn');
      if (postCommentBtn) {
        postCommentBtn.addEventListener('click', function(e) {
          e.preventDefault();
          var target = document.getElementById('postCommentsContainer');
          if (target) {
            target.scrollIntoView({ behavior: 'smooth' });
            var textarea = target.querySelector('textarea');
            if (textarea) {
              setTimeout(function() { textarea.focus(); }, 350);
            }
          }
        });
      }

      var postCommentsList = document.getElementById('postCommentsList');
      var postCommentForm = document.getElementById('postCommentForm');
      var postCommentsBadge = document.getElementById('postCommentsBadge');

      if (postCommentForm && postCommentsList) {
        loadComments(postKey, postCommentsList);
        setupCommentForm(postCommentForm, postKey, postCommentsList, function(increment) {
          if (postCommentsBadge) {
            var curr = parseInt((postCommentsBadge.textContent || '').replace(/\D/g, '') || '0', 10);
            postCommentsBadge.textContent = '(' + (curr + increment) + ')';
          }
          var countEls = postWrap.querySelectorAll('.comment-count');
          countEls.forEach(function(el) {
            var c = parseInt(el.textContent || '0', 10) || 0;
            el.textContent = c + increment;
          });
        });
      }
    }

    // 动态页事件委托 (Moments)
    document.addEventListener('click', function(e) {
      // 点赞按钮
      var likeBtn = e.target.closest('.moment-like-btn');
      if (likeBtn) {
        e.preventDefault();
        handleLikeClick(likeBtn);
        return;
      }

      // 展开/折叠评论抽屉按钮
      var commentBtn = e.target.closest('.moment-comment-btn');
      if (commentBtn) {
        e.preventDefault();
        var momentItem = commentBtn.closest('.moment-item');
        if (!momentItem) return;
        var drawer = momentItem.querySelector('.moment-comments-drawer');
        if (!drawer) return;

        var isHidden = drawer.style.display === 'none' || !drawer.style.display;
        if (isHidden) {
          drawer.style.display = 'block';
          drawer.setAttribute('aria-hidden', 'false');
          commentBtn.classList.add('active');

          var listEl = drawer.querySelector('.drawer-comments-list');
          var formEl = drawer.querySelector('.moment-comment-form');
          var key = commentBtn.closest('[data-key]').getAttribute('data-key');

          if (listEl && !drawer._loaded) {
            loadComments(key, listEl);
            drawer._loaded = true;

            if (formEl) {
              var countEl = commentBtn.querySelector('.comment-count');
              setupCommentForm(formEl, key, listEl, function(increment) {
                var c = parseInt(countEl ? countEl.textContent : '0', 10) || 0;
                if (countEl) countEl.textContent = c + increment;
              });
            }
          }
        } else {
          drawer.style.display = 'none';
          drawer.setAttribute('aria-hidden', 'true');
          commentBtn.classList.remove('active');
        }
      }
    });

    // 扫描并批量获取统计数据
    scanAndFetchStats();

    // 自动加载默认展开的动态评论 (如单条动态独立详情页)
    var openDrawers = document.querySelectorAll('.moment-comments-drawer:not([style*="display: none"]):not([style*="display:none"])');
    openDrawers.forEach(function(drawer) {
      var item = drawer.closest('.moment-item');
      if (!item) return;
      var actionsWrap = item.querySelector('[data-key]');
      if (!actionsWrap) return;
      var key = actionsWrap.getAttribute('data-key');
      var listEl = drawer.querySelector('.drawer-comments-list');
      var formEl = drawer.querySelector('.moment-comment-form');
      var countEl = item.querySelector('.comment-count');
      if (listEl && !drawer._loaded) {
        loadComments(key, listEl);
        drawer._loaded = true;
        if (formEl) {
          setupCommentForm(formEl, key, listEl, function(increment) {
            var c = parseInt(countEl ? countEl.textContent : '0', 10) || 0;
            if (countEl) countEl.textContent = c + increment;
          });
        }
      }
    });

    // 监听动态流瀑布流追加 (Infinite Scroll 适配)
    var momentsList = document.getElementById('momentsList');
    if (momentsList && window.MutationObserver) {
      var observer = new MutationObserver(function() {
        scanAndFetchStats();
      });
      observer.observe(momentsList, { childList: true, subtree: false });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initInteractions);
  } else {
    initInteractions();
  }
})();
