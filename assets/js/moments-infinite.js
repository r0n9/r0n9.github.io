(function () {
  'use strict';

  function initInfiniteScroll() {
    const sentinel = document.getElementById('momentsInfiniteSentinel');
    const momentsList = document.getElementById('momentsList');
    if (!sentinel || !momentsList) return;

    let isLoading = false;
    const domParser = new DOMParser();

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && !isLoading) {
            loadNextPage();
          }
        });
      },
      {
        root: null,
        rootMargin: '300px 0px',
        threshold: 0
      }
    );

    observer.observe(sentinel);

    async function loadNextPage() {
      const nextUrl = sentinel.dataset.nextUrl;
      if (!nextUrl || isLoading) return;

      isLoading = true;
      sentinel.classList.add('loading');

      try {
        const response = await fetch(nextUrl);
        if (!response.ok) {
          throw new Error(`Failed to load: ${response.status}`);
        }

        const html = await response.text();
        const doc = domParser.parseFromString(html, 'text/html');
        const newItems = Array.from(doc.querySelectorAll('.moment-item'));

        if (newItems.length > 0) {
          const fragment = document.createDocumentFragment();
          newItems.forEach((item) => {
            item.classList.add('moment-item-appended');
            fragment.appendChild(item);
          });
          momentsList.appendChild(fragment);
        }

        // Check if fetched page has subsequent next url
        const newSentinel = doc.getElementById('momentsInfiniteSentinel');
        const nextNextUrl = newSentinel?.dataset?.nextUrl;

        if (nextNextUrl) {
          sentinel.dataset.nextUrl = nextNextUrl;
          isLoading = false;
          sentinel.classList.remove('loading');
        } else {
          observer.disconnect();
          const endDiv = document.createElement('div');
          endDiv.className = 'moments-end-indicator';
          endDiv.textContent = '— 已展示全部随手记 —';
          sentinel.replaceWith(endDiv);
        }
      } catch (err) {
        console.error('Moments infinite scroll error:', err);
        isLoading = false;
        sentinel.classList.remove('loading');
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initInfiniteScroll);
  } else {
    initInfiniteScroll();
  }
})();
