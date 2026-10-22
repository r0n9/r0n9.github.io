import * as params from '@params';

const resList = document.getElementById('searchResults');
const sInput = document.getElementById('searchInput');
const searchBox = document.getElementById('searchbox');
const searchStats = document.getElementById('searchStats');
const clearBtn = document.getElementById('searchClearBtn');

let fuse;
let currentElement = null;
let firstResult = null;
let lastResult = null;

const defaultFuseOptions = {
    distance: 100,
    threshold: 0.25,
    ignoreLocation: true,
    minMatchCharLength: 1,
    keys: [
        { name: 'title', weight: 0.6 },
        { name: 'description', weight: 0.3 },
        { name: 'content', weight: 0.1 }
    ]
};

const buildFuseOptions = () => {
    if (!params.fuseOpts) {
        return defaultFuseOptions;
    }

    return {
        isCaseSensitive: params.fuseOpts.iscasesensitive ?? false,
        includeScore: params.fuseOpts.includescore ?? false,
        includeMatches: params.fuseOpts.includematches ?? false,
        minMatchCharLength: params.fuseOpts.minmatchcharlength ?? 1,
        shouldSort: params.fuseOpts.shouldsort ?? true,
        findAllMatches: params.fuseOpts.findallmatches ?? false,
        keys: params.fuseOpts.keys ?? defaultFuseOptions.keys,
        location: params.fuseOpts.location ?? 0,
        threshold: params.fuseOpts.threshold ?? defaultFuseOptions.threshold,
        distance: params.fuseOpts.distance ?? defaultFuseOptions.distance,
        ignoreLocation: params.fuseOpts.ignorelocation ?? defaultFuseOptions.ignoreLocation
    };
};

const debounce = (fn, delay) => {
    let timeout;
    return (...args) => {
        clearTimeout(timeout);
        timeout = window.setTimeout(() => fn(...args), delay);
    };
};

const escapeHtml = (str) => {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
};

const escapeRegex = (str) => {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

const highlightMatch = (text, query) => {
    if (!text || !query) return escapeHtml(text);
    const escapedText = escapeHtml(text);
    const words = query.trim().split(/\s+/).filter(w => w.length > 0);
    if (words.length === 0) return escapedText;

    const pattern = new RegExp(`(${words.map(escapeRegex).join('|')})`, 'gi');
    return escapedText.replace(pattern, '<mark class="search-mark">$1</mark>');
};

const generateSnippet = (item, query) => {
    const rawContent = item.content || item.description || '';
    if (!query) return item.description ? item.description.slice(0, 120) : '';

    const lowerContent = rawContent.toLowerCase();
    const words = query.trim().toLowerCase().split(/\s+/).filter(w => w.length > 0);
    
    let matchIndex = -1;
    for (const w of words) {
        const idx = lowerContent.indexOf(w);
        if (idx !== -1 && (matchIndex === -1 || idx < matchIndex)) {
            matchIndex = idx;
        }
    }

    if (matchIndex === -1) {
        const fallback = item.description || rawContent;
        return fallback.slice(0, 110) + (fallback.length > 110 ? '...' : '');
    }

    const start = Math.max(0, matchIndex - 35);
    const end = Math.min(rawContent.length, matchIndex + 90);
    let snippet = rawContent.slice(start, end).replace(/\s+/g, ' ').trim();

    if (start > 0) snippet = '...' + snippet;
    if (end < rawContent.length) snippet = snippet + '...';

    return snippet;
};

const reset = () => {
    currentElement = null;
    firstResult = null;
    lastResult = null;
    if (resList) resList.innerHTML = '';
    if (searchStats) searchStats.innerHTML = '';
    if (clearBtn) clearBtn.style.display = 'none';
    if (sInput) {
        sInput.value = '';
        sInput.focus();
    }
};

const setActiveResult = (element) => {
    document.querySelectorAll('.search-result-item.focus').forEach((item) => item.classList.remove('focus'));

    if (!element) return;

    element.focus();
    const itemLi = element.closest('.search-result-item');
    if (itemLi) itemLi.classList.add('focus');
    currentElement = element;
};

const renderResults = (results, query) => {
    if (clearBtn) {
        clearBtn.style.display = query ? 'flex' : 'none';
    }

    if (!query) {
        if (resList) resList.innerHTML = '';
        if (searchStats) searchStats.innerHTML = '';
        firstResult = lastResult = currentElement = null;
        return;
    }

    if (!Array.isArray(results) || results.length === 0) {
        if (resList) resList.innerHTML = '';
        if (searchStats) {
            searchStats.innerHTML = `<span class="search-empty">未找到与 “<span class="search-query-highlight">${escapeHtml(query)}</span>” 相关的文章</span>`;
        }
        firstResult = lastResult = currentElement = null;
        return;
    }

    if (searchStats) {
        searchStats.innerHTML = `<span class="search-count">找到 <strong>${results.length}</strong> 篇相关文章</span>`;
    }

    const fragment = document.createDocumentFragment();

    for (const result of results) {
        const item = result.item;
        const li = document.createElement('li');
        li.className = 'search-result-item';

        // Title
        const titleHeading = document.createElement('h2');
        titleHeading.className = 'search-result-title';

        if (item.badge) {
            const badgeSpan = document.createElement('span');
            badgeSpan.className = 'search-result-badge search-badge-moment';
            badgeSpan.textContent = item.badge;
            titleHeading.appendChild(badgeSpan);
        }

        const titleLink = document.createElement('a');
        titleLink.href = item.permalink;
        titleLink.className = 'search-result-link entry-link';
        titleLink.innerHTML = highlightMatch(item.title, query);
        titleHeading.appendChild(titleLink);
        li.appendChild(titleHeading);

        // Date / Meta
        if (item.date) {
            const metaDiv = document.createElement('div');
            metaDiv.className = 'search-result-meta';
            metaDiv.innerHTML = `
                <svg class="search-meta-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path stroke="none" d="M0 0h24v24H0z"/>
                    <path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/>
                    <path d="M16 3v4M8 3v4M4 11h16M7 14h.013M10.01 14h.005M13.01 14h.005M16.015 14h.005M13.015 17h.005M7.01 17h.005M10.01 17h.005"/>
                </svg>
                <time>${escapeHtml(item.date)}</time>
            `;
            li.appendChild(metaDiv);
        }

        // Snippet
        const snippetText = generateSnippet(item, query);
        if (snippetText) {
            const snippetP = document.createElement('p');
            snippetP.className = 'search-result-snippet';
            snippetP.innerHTML = highlightMatch(snippetText, query);
            li.appendChild(snippetP);
        }

        fragment.appendChild(li);
    }

    if (resList) {
        resList.innerHTML = '';
        resList.appendChild(fragment);
        firstResult = resList.firstElementChild?.querySelector('.entry-link');
        lastResult = resList.lastElementChild?.querySelector('.entry-link');
    }
};

const performSearch = () => {
    if (!fuse || !sInput) return;

    const query = sInput.value.trim();
    if (!query) {
        renderResults([], '');
        return;
    }

    const searchOptions = params.fuseOpts?.limit ? { limit: params.fuseOpts.limit } : undefined;
    const results = searchOptions ? fuse.search(query, searchOptions) : fuse.search(query);
    renderResults(results, query);
};

const initSearch = async () => {
    if (!sInput || !resList) return;

    sInput.disabled = false;
    sInput.focus();

    if (clearBtn) {
        clearBtn.addEventListener('click', reset);
    }

    try {
        const response = await fetch('../index.json');
        if (!response.ok) {
            throw new Error(`Search index load failed: ${response.status}`);
        }

        const data = await response.json();
        if (data) {
            fuse = new Fuse(data, buildFuseOptions());
            if (sInput.value.trim()) {
                performSearch();
            }
        }
    } catch (error) {
        console.error(error);
    }
};

window.addEventListener('load', initSearch);

sInput?.addEventListener('input', debounce(performSearch, 150));

sInput?.addEventListener('search', () => {
    if (!sInput.value) {
        reset();
    }
});

document.addEventListener('keydown', (event) => {
    const { key } = event;
    const active = document.activeElement;
    const isInSearchBox = searchBox?.contains(active);

    if (key === 'Escape') {
        reset();
        return;
    }

    if (!firstResult || !isInSearchBox) return;

    if (key === 'ArrowDown') {
        event.preventDefault();
        if (active === sInput) {
            setActiveResult(firstResult);
        } else if (active?.closest('.search-result-item') !== resList.lastElementChild) {
            const nextItem = active.closest('.search-result-item')?.nextElementSibling?.querySelector('.entry-link');
            if (nextItem) setActiveResult(nextItem);
        }
    } else if (key === 'ArrowUp') {
        event.preventDefault();
        if (active?.closest('.search-result-item') === resList.firstElementChild) {
            setActiveResult(sInput);
        } else if (active !== sInput) {
            const prevItem = active.closest('.search-result-item')?.previousElementSibling?.querySelector('.entry-link');
            if (prevItem) setActiveResult(prevItem);
        }
    } else if (key === 'ArrowRight' || key === 'Enter') {
        if (active?.matches?.('.entry-link')) {
            active.click();
        }
    }
});
