(() => {
  'use strict';

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
  if ('IntersectionObserver' in window && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const observer = new IntersectionObserver((entries, currentObserver) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          currentObserver.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12 });
    revealItems.forEach((item) => observer.observe(item));
  } else {
    revealItems.forEach((item) => item.classList.add('is-visible'));
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
