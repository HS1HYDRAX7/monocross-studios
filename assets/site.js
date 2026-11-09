(() => {
  'use strict';

  const root = document.documentElement;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  root.classList.add('js');

  const menuButton = document.querySelector('.menu-button');
  const mobileNav = document.querySelector('.mobile-nav');

  if (menuButton && mobileNav) {
    menuButton.addEventListener('click', () => {
      const expanded = menuButton.getAttribute('aria-expanded') === 'true';
      menuButton.setAttribute('aria-expanded', String(!expanded));
      mobileNav.hidden = expanded;
    });

    mobileNav.addEventListener('click', (event) => {
      if (event.target.closest('a')) {
        menuButton.setAttribute('aria-expanded', 'false');
        mobileNav.hidden = true;
      }
    });
  }

  const revealItems = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window && !reducedMotion) {
    const observer = new IntersectionObserver((entries, currentObserver) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          currentObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -35px 0px' });
    revealItems.forEach((item) => observer.observe(item));
  } else {
    revealItems.forEach((item) => item.classList.add('is-visible'));
  }

  const header = document.querySelector('.site-header');
  const progress = document.createElement('div');
  progress.className = 'scroll-progress';
  progress.setAttribute('aria-hidden', 'true');
  progress.append(document.createElement('span'));
  document.body.append(progress);

  let scrollQueued = false;
  const updateScrollEffects = () => {
    const scrollable = document.documentElement.scrollHeight - window.innerHeight;
    progress.firstElementChild.style.transform = `scaleX(${scrollable > 0 ? window.scrollY / scrollable : 0})`;
    if (header) header.classList.toggle('is-scrolled', window.scrollY > 24);
    scrollQueued = false;
  };
  window.addEventListener('scroll', () => {
    if (!scrollQueued) {
      window.requestAnimationFrame(updateScrollEffects);
      scrollQueued = true;
    }
  }, { passive: true });
  updateScrollEffects();

  const navLinks = [...document.querySelectorAll('.main-nav a')];
  const observedSections = navLinks
    .map((link) => document.querySelector(link.getAttribute('href')))
    .filter(Boolean);
  if ('IntersectionObserver' in window && observedSections.length) {
    const sectionObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        navLinks.forEach((link) => {
          const active = link.getAttribute('href') === `#${entry.target.id}`;
          if (active) link.classList.add('is-active');
          else link.classList.remove('is-active');
        });
      });
    }, { rootMargin: '-30% 0px -60% 0px' });
    observedSections.forEach((section) => sectionObserver.observe(section));
  }

  const updatesList = document.querySelector('#updatesList');
  if (!updatesList) return;

  const makeText = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = text;
    return element;
  };

  const renderUpdates = (games) => {
    const updates = games.flatMap((game) => (game.updates || []).map((update) => ({
      ...update,
      gameName: game.name || game.slug || 'Studio',
    })));
    updates.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    updatesList.replaceChildren();

    if (!updates.length) {
      updatesList.append(makeText('li', 'empty-state', 'No updates have been published yet. Check back soon.'));
      return;
    }

    updates.slice(0, 5).forEach((update) => {
      const item = makeText('li', 'update-item', '');
      const date = makeText('time', 'update-date', update.date || 'Date unavailable');
      if (update.date) date.dateTime = update.date;
      const copy = makeText('div', 'update-copy', '');
      const heading = makeText('h3', '', `${update.gameName} · ${update.title || 'Development update'}`);
      const summary = makeText('p', '', (update.paragraphs || []).join(' '));
      copy.append(heading, summary);
      item.append(date, copy);
      updatesList.append(item);
    });
  };

  fetch('/api/devlog', { headers: { Accept: 'application/json' } })
    .then((response) => {
      if (!response.ok) throw new Error(`Devlog request failed (${response.status})`);
      return response.json();
    })
    .then((data) => renderUpdates(Array.isArray(data.games) ? data.games : []))
    .catch(() => {
      updatesList.replaceChildren(makeText('li', 'empty-state', 'Updates are unavailable right now. Please try again later.'));
    });
})();
