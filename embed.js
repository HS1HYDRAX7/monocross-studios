/*!
 * Monocross Studios ad embed (v1)
 *
 * Add the script once, then one tag per ad slot:
 *
 *   <script src="https://monocross-studios.vercel.app/embed.js" async></script>
 *
 *   <div data-monocross-ad="banner" data-size="small"></div>
 *   <div data-monocross-ad="banner" data-size="medium"></div>
 *   <div data-monocross-ad="banner" data-size="big"></div>
 *   <div data-monocross-ad="popup" data-size="medium" data-delay="5" data-frequency="day"></div>
 *
 * Sizes: small (320 x 96), medium (320 wide, card), big (728 wide).
 * Popup widths: small 320, medium 420, big 640.
 * For slots added after the page loads, call window.MonocrossAds.init(container).
 *
 * Every ad is drawn inside a Shadow DOM, so the host page's CSS cannot change it.
 * Text is written with textContent and links and images must be https://.
 */
(function () {
  'use strict';

  var API = 'https://monocross-studios.vercel.app/api/embed';
  var SIZES = ['small', 'medium', 'big'];
  var POPUP_WIDTHS = { small: 320, medium: 420, big: 640 };
  var ROTATE_MS = 7000;
  var MAX_DELAY_S = 120;
  var reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var cache = {};

  var STYLE = `
    :host { display: block; max-width: 100%; color-scheme: dark; }
    *, *::before, *::after { box-sizing: border-box; }
    .ad { position: relative; display: block; max-width: 100%; color: #f4f4f4; background: #070707;
          border: 1px solid rgba(255,255,255,.08); border-radius: 16px; overflow: hidden; text-decoration: none;
          font-family: Inter, system-ui, -apple-system, 'Segoe UI', sans-serif;
          transition: border-color .2s ease, transform .25s cubic-bezier(.16,1,.3,1), box-shadow .25s ease; }
    .ad:not(.active) { display: none; }
    .ad.active { animation: rise .5s cubic-bezier(.16,1,.3,1) both; }
    .ad:not(.is-static):hover { border-color: rgba(255,59,63,.45); transform: translateY(-2px); box-shadow: 0 12px 40px rgba(0,0,0,.45); }
    .ad:focus-visible { outline: 2px solid #ff3b3f; outline-offset: 3px; }
    .small { width: 320px; height: 96px; display: grid; grid-template-columns: 96px 1fr; }
    .medium { width: 320px; display: flex; flex-direction: column; }
    .big { width: 728px; min-height: 160px; display: grid; grid-template-columns: 42% 1fr; }
    .frame { position: relative; overflow: hidden; background: #0f0f0f; }
    .small .frame { height: 100%; }
    .medium .frame { aspect-ratio: 16 / 10; }
    .big .frame { min-height: 160px; }
    .frame::after { content: ''; position: absolute; inset: 0; pointer-events: none;
                    background: linear-gradient(90deg, transparent 45%, #070707 100%); }
    .medium .frame::after { background: linear-gradient(180deg, transparent 50%, #070707 100%); }
    .frame.skel { background: linear-gradient(100deg, #141414 30%, #222 50%, #141414 70%) 0 0 / 200% 100%;
                  animation: shimmer 1.4s linear infinite; }
    .frame img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0;
                 transition: opacity .6s ease, transform .8s cubic-bezier(.16,1,.3,1); }
    .frame img.on { opacity: 1; }
    .ad:not(.is-static):hover .frame img.on { transform: scale(1.03); }
    .body { display: flex; flex-direction: column; justify-content: center; gap: 6px; min-width: 0; padding: 12px 14px; }
    .medium .body { flex: 1; gap: 10px; padding: 16px 18px 18px; }
    .big .body { gap: 10px; padding: 18px 22px; }
    .label { font: 500 10px/1 ui-monospace, Menlo, Consolas, monospace; letter-spacing: .14em; text-transform: uppercase; color: #8a8a8a; }
    .logo { font: 900 18px/1 'Barlow Condensed', Impact, 'Arial Narrow', sans-serif; letter-spacing: .04em; text-transform: uppercase; }
    .medium .logo { font-size: 22px; }
    .big .logo { font-size: 24px; }
    .logo b { color: #ff3b3f; font-weight: 900; }
    .title { font-size: 13px; font-weight: 600; color: #d8d8d8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .big .title { font-size: 17px; }
    .desc { font-size: 13px; line-height: 1.45; color: #b4b4b4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .cta { display: inline-flex; align-items: center; gap: 6px; align-self: flex-start; margin-top: 2px;
           font: 500 11px/1 ui-monospace, Menlo, Consolas, monospace; letter-spacing: .1em; text-transform: uppercase; color: #ff3b3f; }
    .cta svg { width: 14px; height: 14px; flex-shrink: 0; }
    .ad:not(.is-static):hover .cta { color: #ff5b5f; }
    @media (max-width: 560px) {
      .big { width: 100%; grid-template-columns: 1fr; }
      .big .frame { min-height: 0; aspect-ratio: 16 / 9; }
    }
    .popup { width: min(var(--w), calc(100vw - 32px)); padding: 0; border: 1px solid rgba(255,255,255,.12);
             border-radius: 22px; background: #0e0e0e; color: #f4f4f4; overflow: hidden; box-shadow: 0 40px 80px -30px #000; }
    .popup[open] { animation: pop .45s cubic-bezier(.16,1,.3,1) both; }
    .popup::backdrop { background: rgba(0,0,0,.72); backdrop-filter: blur(4px); }
    .popup .frame { height: 200px; }
    .popup .frame::after { background: linear-gradient(180deg, transparent 50%, #0e0e0e 100%); }
    .pop-body { display: grid; gap: 12px; padding: 18px 22px 22px; }
    .pop-title { font: 800 30px/1 'Barlow Condensed', Impact, 'Arial Narrow', sans-serif; text-transform: uppercase; }
    .pop-cta { display: inline-flex; justify-content: center; padding: 12px 18px; border-radius: 999px; background: #ff3b3f;
               color: #fff; font: 600 14px/1 Inter, system-ui, sans-serif; text-decoration: none; }
    .pop-cta:focus-visible, .close:focus-visible { outline: 2px solid #ff3b3f; outline-offset: 3px; }
    .close { position: absolute; top: 10px; right: 10px; z-index: 2; width: 36px; height: 36px; border: 0; border-radius: 50%;
             background: rgba(0,0,0,.6); color: #fff; font: 400 22px/1 system-ui, sans-serif; cursor: pointer; }
    @keyframes shimmer { from { background-position: 100% 0; } to { background-position: -100% 0; } }
    @keyframes rise { from { opacity: 0; transform: translateY(10px); } }
    @keyframes pop { from { opacity: 0; transform: translateY(18px) scale(.98); } }
    @media (prefers-reduced-motion: reduce) {
      .ad, .ad.active, .frame.skel, .popup[open] { animation: none !important; transition: none !important; }
    }
  `;

  var FONTS = 'https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@800;900&family=Inter:wght@400;500;600&display=swap';
  var ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>';

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function httpsUrl(value) {
    try {
      return new URL(String(value || '')).protocol === 'https:' ? String(value) : '';
    } catch (err) {
      return '';
    }
  }

  function brand() {
    var logo = el('div', 'logo');
    logo.append('MONO', el('b', null, 'CROSS'));
    return logo;
  }

  function newRoot(host) {
    var root = host.attachShadow({ mode: 'open' });
    var fonts = el('link');
    fonts.rel = 'stylesheet';
    fonts.href = FONTS;
    var style = el('style');
    style.textContent = STYLE;
    root.append(fonts, style);
    return root;
  }

  // One request per kind and size, shared by every slot on the page.
  function fetchItems(kind, size) {
    var key = kind + '|' + size;
    if (!cache[key]) {
      cache[key] = fetch(API + '?kind=' + encodeURIComponent(kind) + '&size=' + encodeURIComponent(size))
        .then(function (response) {
          if (!response.ok) throw new Error('Monocross ads: HTTP ' + response.status);
          return response.json();
        })
        .then(function (data) {
          return (data.items || []).filter(function (item) { return httpsUrl(item.image); });
        });
      cache[key].catch(function () { delete cache[key]; });
    }
    return cache[key];
  }

  function pick(items) {
    return items[Math.floor(Math.random() * items.length)];
  }

  function buildBanner(item, size, onImageError) {
    var link = httpsUrl(item.link);
    var card = el(link ? 'a' : 'div', 'ad ' + size + (link ? '' : ' is-static'));
    if (link) {
      card.href = link;
      card.target = '_blank';
      card.rel = 'noopener sponsored';
      card.setAttribute('aria-label', item.title || 'Monocross Studios');
    }

    var frame = el('div', 'frame skel');
    var img = el('img');
    img.alt = item.title || '';
    img.decoding = 'async';
    img.onload = function () { img.classList.add('on'); frame.classList.remove('skel'); };
    img.onerror = function () { card.remove(); onImageError(); };
    img.src = httpsUrl(item.image);
    frame.append(img);

    var body = el('div', 'body');
    body.append(el('div', 'label', item.label || 'Advertisement'), brand(), el('div', 'title', item.title || ''));
    if (size !== 'small' && item.description) body.append(el('p', 'desc', item.description));
    var cta = el('span', 'cta', item.cta || 'Learn more');
    cta.insertAdjacentHTML('beforeend', ARROW);
    body.append(cta);

    card.append(frame, body);
    return card;
  }

  function mountBanner(host) {
    var size = SIZES.indexOf(host.getAttribute('data-size')) !== -1 ? host.getAttribute('data-size') : 'medium';
    var root = newRoot(host);

    fetchItems('banner', size).then(function (items) {
      if (!items.length) { host.style.display = 'none'; return; }
      var cards = [];

      var hide = function () { if (!root.querySelector('.ad')) host.style.display = 'none'; };
      items.forEach(function (item) {
        var card = buildBanner(item, size, hide);
        cards.push(card);
        root.append(card);
      });
      if (!cards.length) return;

      var index = 0;
      var show = function (next) {
        cards.forEach(function (card, i) { card.classList.toggle('active', i === next); });
        index = next;
      };
      show(0);

      // With more than one creative, rotate slowly. Pause while the reader is on the card.
      if (cards.length > 1 && !reduceMotion) {
        var paused = false;
        host.addEventListener('mouseenter', function () { paused = true; });
        host.addEventListener('mouseleave', function () { paused = false; });
        setInterval(function () {
          if (!paused && document.visibilityState === 'visible') show((index + 1) % cards.length);
        }, ROTATE_MS);
      }
    }).catch(function () {
      host.style.display = 'none';
    });
  }

  function seenKey(id) {
    return 'mc-embed-popup:' + id;
  }

  function wasSeen(key, frequency) {
    try {
      if (frequency === 'day') return localStorage.getItem(key) === new Date().toISOString().slice(0, 10);
      return sessionStorage.getItem(key) === '1';
    } catch (err) {
      return false;
    }
  }

  function markSeen(key, frequency) {
    try {
      if (frequency === 'day') localStorage.setItem(key, new Date().toISOString().slice(0, 10));
      else sessionStorage.setItem(key, '1');
    } catch (err) { /* storage blocked: the popup may show again */ }
  }

  function buildPopup(item, width, onClose) {
    var dialog = el('dialog', 'popup');
    dialog.style.setProperty('--w', width + 'px');
    dialog.setAttribute('aria-label', item.title || 'Monocross Studios');

    var close = el('button', 'close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', onClose);

    var frame = el('div', 'frame skel');
    var img = el('img');
    img.alt = item.title || '';
    img.onload = function () { img.classList.add('on'); frame.classList.remove('skel'); };
    img.onerror = function () { dialog.remove(); };
    img.src = httpsUrl(item.image);
    frame.append(img);

    var body = el('div', 'pop-body');
    body.append(el('div', 'label', item.label || 'Advertisement'), el('div', 'pop-title', item.title || ''));
    if (item.description) body.append(el('p', 'desc', item.description));
    var link = httpsUrl(item.link);
    if (link) {
      var cta = el('a', 'pop-cta', item.cta || 'Learn more');
      cta.href = link;
      cta.target = '_blank';
      cta.rel = 'noopener sponsored';
      body.append(cta);
    }

    dialog.append(close, frame, body);
    // A click on the backdrop closes the popup. The dialog is the click target there.
    dialog.addEventListener('click', function (event) { if (event.target === dialog) onClose(); });
    return dialog;
  }

  function mountPopup(host) {
    var size = SIZES.indexOf(host.getAttribute('data-size')) !== -1 ? host.getAttribute('data-size') : 'medium';
    var frequency = host.getAttribute('data-frequency') === 'day' ? 'day' : 'session';
    var key = seenKey(host.getAttribute('data-id') || 'default');
    if (wasSeen(key, frequency)) return;

    var root = newRoot(host);
    fetchItems('popup', size).then(function (items) {
      if (!items.length) return;
      var item = pick(items);
      var delay = Number(host.getAttribute('data-delay'));
      if (!isFinite(delay)) delay = Number(item.delaySeconds);
      if (!isFinite(delay)) delay = 3;
      delay = Math.min(MAX_DELAY_S, Math.max(0, delay));

      setTimeout(function () {
        if (wasSeen(key, frequency) || document.querySelector('dialog[open]')) return;
        var dialog = buildPopup(item, POPUP_WIDTHS[size], function () { dialog.close(); dialog.remove(); });
        root.append(dialog);
        markSeen(key, frequency);
        dialog.showModal();
      }, delay * 1000);
    }).catch(function () { /* no popup when the API is unreachable */ });
  }

  function init(scope) {
    var nodes = (scope || document).querySelectorAll('[data-monocross-ad]:not([data-mc-ready])');
    Array.prototype.forEach.call(nodes, function (node) {
      node.setAttribute('data-mc-ready', '');
      var kind = node.getAttribute('data-monocross-ad');
      if (kind === 'banner') mountBanner(node);
      else if (kind === 'popup') mountPopup(node);
    });
  }

  window.MonocrossAds = { init: init, version: 1 };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { init(document); });
  else init(document);
})();
