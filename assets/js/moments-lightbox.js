(function () {
  'use strict';

  function initLightbox() {
    const lightbox = document.getElementById('momentLightbox');
    if (!lightbox) return;

    const lightboxImg = document.getElementById('lightboxImg');
    const closeBtn = document.getElementById('lightboxCloseBtn');
    const prevBtn = document.getElementById('lightboxPrevBtn');
    const nextBtn = document.getElementById('lightboxNextBtn');
    const counter = document.getElementById('lightboxCounter');

    let currentImages = [];
    let currentIndex = 0;
    let isOpen = false;

    function updateView() {
      if (!currentImages.length) return;
      const curImg = currentImages[currentIndex];
      lightboxImg.src = curImg.src;
      lightboxImg.alt = curImg.alt || '预览大图';

      const total = currentImages.length;
      if (total > 1) {
        if (counter) counter.textContent = `第 ${currentIndex + 1} 张，共 ${total} 张`;
        if (prevBtn) prevBtn.style.display = 'flex';
        if (nextBtn) nextBtn.style.display = 'flex';
      } else {
        if (counter) counter.textContent = '';
        if (prevBtn) prevBtn.style.display = 'none';
        if (nextBtn) nextBtn.style.display = 'none';
      }
    }

    function openLightbox(images, index) {
      currentImages = images;
      currentIndex = index;
      isOpen = true;
      lightbox.classList.add('active');
      lightbox.setAttribute('aria-hidden', 'false');
      document.body.style.overflow = 'hidden';
      updateView();
    }

    function closeLightbox() {
      if (!isOpen) return;
      isOpen = false;
      lightbox.classList.remove('active');
      lightbox.setAttribute('aria-hidden', 'true');
      document.body.style.overflow = '';
      setTimeout(() => {
        if (!isOpen && lightboxImg) lightboxImg.src = '';
      }, 250);
    }

    function prevImage() {
      if (!isOpen || currentImages.length <= 1) return;
      currentIndex = (currentIndex - 1 + currentImages.length) % currentImages.length;
      updateView();
    }

    function nextImage() {
      if (!isOpen || currentImages.length <= 1) return;
      currentIndex = (currentIndex + 1) % currentImages.length;
      updateView();
    }

    // Attach click events on moment images
    const roots = document.querySelectorAll('[data-image-lightbox-root]');
    roots.forEach((root) => {
      root.addEventListener('click', (e) => {
        const target = e.target;
        if (target.tagName.toLowerCase() !== 'img') return;

        // Skip avatar
        if (target.classList.contains('moment-avatar')) return;

        // Check if inside gallery
        const gallery = target.closest('.moment-gallery');
        if (gallery) {
          const imgs = Array.from(gallery.querySelectorAll('img'));
          const idx = imgs.indexOf(target);
          if (idx !== -1) {
            e.preventDefault();
            openLightbox(imgs, idx);
            return;
          }
        }

        // Check if inside moment body
        const body = target.closest('.moment-body');
        if (body) {
          const imgs = Array.from(body.querySelectorAll('img'));
          const idx = imgs.indexOf(target);
          if (idx !== -1) {
            e.preventDefault();
            openLightbox(imgs, idx);
          }
        }
      });
    });

    closeBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      closeLightbox();
    });

    prevBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      prevImage();
    });

    nextBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      nextImage();
    });

    // Close on backdrop click (click outside image)
    lightbox.addEventListener('click', (e) => {
      if (e.target === lightbox || e.target.id === 'lightboxContent') {
        closeLightbox();
      }
    });

    // Keyboard navigation
    document.addEventListener('keydown', (e) => {
      if (!isOpen) return;
      if (e.key === 'Escape') {
        closeLightbox();
      } else if (e.key === 'ArrowLeft') {
        prevImage();
      } else if (e.key === 'ArrowRight') {
        nextImage();
      }
    });

    // Touch swipe support on mobile
    let touchStartX = 0;
    let touchStartY = 0;

    lightbox.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
      }
    }, { passive: true });

    lightbox.addEventListener('touchend', (e) => {
      if (e.changedTouches.length === 1) {
        const diffX = e.changedTouches[0].clientX - touchStartX;
        const diffY = e.changedTouches[0].clientY - touchStartY;
        if (Math.abs(diffX) > 45 && Math.abs(diffX) > Math.abs(diffY)) {
          if (diffX > 0) {
            prevImage();
          } else {
            nextImage();
          }
        }
      }
    }, { passive: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initLightbox);
  } else {
    initLightbox();
  }
})();
