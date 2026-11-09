/*! Monocross embed v1. Shows official popups and ad campaigns configured in the Monocross API.
 *  <script async src="https://monocross-studios.vercel.app/embed.js" data-site="SITE_ID" data-token="PUBLIC_TOKEN"></script>
 *  Optional: <div data-monocross-slot data-size="small|medium|large"></div> for inline ads.
 *  Options on the script tag: data-lang, data-consent="required", data-api.
 *  Safe by design: all text is set with textContent, links must be https, everything lives in a Shadow DOM. */
(function () {
  'use strict';
  if (window.__monocrossEmbed) return;
  window.__monocrossEmbed = true;

  var script = document.currentScript || (function () {
    var all = document.getElementsByTagName('script');
    for (var i = all.length - 1; i >= 0; i--) if (/\/embed\.js(\?|$)/.test(all[i].src)) return all[i];
    return null;
  })();
  if (!script) return;
  var site = script.getAttribute('data-site');
  var token = script.getAttribute('data-token');
  if (!site || !token) { console.warn('[monocross] data-site and data-token are required'); return; }
  var api = (script.getAttribute('data-api') || new URL(script.src, location.href).origin).replace(/\/$/, '');
  var consentRequired = script.getAttribute('data-consent') === 'required';
  var lang = (script.getAttribute('data-lang') || document.documentElement.lang || navigator.language || 'en').slice(0, 2).toLowerCase();
  var KEY = 'mx_ads_v1';
  var SESSION_KEY = 'mx_ads_session';
  var reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var doNotTrack = navigator.doNotTrack === '1' || navigator.globalPrivacyControl === true;

  // ---------- storage (fails quietly in private mode) ----------
  function readStore() { try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { return {}; } }
  function writeStore(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) { /* ignore */ } }
  function sessionCount() { try { return Number(sessionStorage.getItem(SESSION_KEY) || 0); } catch (e) { return 0; } }
  function bumpSession() { try { sessionStorage.setItem(SESSION_KEY, String(sessionCount() + 1)); } catch (e) { /* ignore */ } }
  function remember(id, what) { var s = readStore(); s[id] = s[id] || {}; s[id][what] = Date.now(); writeStore(s); }
  function hidden(c) {
    var r = readStore()[c.id];
    if (!r) return false;
    var day = 86400000;
    if (r.clicked && Date.now() - r.clicked < c.frequency.click_days * day) return true;
    if (r.closed && Date.now() - r.closed < c.frequency.dismiss_days * day) return true;
    return false;
  }

  // ---------- network ----------
  function device() { var w = window.innerWidth; return w < 640 ? 'mobile' : w < 1024 ? 'tablet' : 'desktop'; }
  function post(path, body, keepalive) {
    var json = JSON.stringify(body);
    return fetch(api + path, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: json, credentials: 'omit', keepalive: !!keepalive });
  }
  function track(c, type) {
    if (doNotTrack) return;
    var body = { site: site, token: token, campaign: c.id, type: type };
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(api + '/api/events', new Blob([JSON.stringify(body)], { type: 'text/plain;charset=UTF-8' }))) return;
    } catch (e) { /* fall through */ }
    post('/api/events', body, true).catch(function () {});
  }

  // ---------- rendering ----------
  var ICONS = {
    discord: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-8l-5 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/><circle cx="9" cy="11" r="1.4"/><circle cx="15" cy="11" r="1.4"/></svg>',
    tiktok: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3v11.5a3.5 3.5 0 1 1-3.5-3.5"/><path d="M14 3c.4 2.6 2 4.2 5 4.5"/></svg>',
    promo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19"/></svg>'
  };
  var CSS = ':host{all:initial}*{box-sizing:border-box}' +
    '.card{--r:oklch(0.66 0.23 24);--r2:oklch(0.74 0.2 24);position:relative;overflow:hidden;color:#f4f4f4;background:#0f0f0f;border:1px solid rgba(255,255,255,.14);border-radius:16px;font:400 15px/1.45 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 20px 60px rgba(0,0,0,.55);text-align:left}' +
    '.card::before{content:"";position:absolute;left:-30%;top:-70%;width:80%;height:200%;background:radial-gradient(closest-side,rgba(255,59,63,.28),transparent);pointer-events:none;animation:drift 7s ease-in-out infinite alternate}' +
    '.row{position:relative;display:flex;gap:14px;padding:16px;align-items:flex-start}' +
    '.ico{flex:none;width:48px;height:48px;border-radius:12px;background:var(--r);display:grid;place-items:center;color:#0a0a0a;animation:bob 3.6s ease-in-out infinite}' +
    '.ico svg{width:26px;height:26px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}' +
    '.ico svg circle{fill:currentColor;stroke:none}' +
    '.txt{min-width:0;flex:1;padding-right:36px}' +
    '.tag{font:600 12px/1 ui-monospace,"JetBrains Mono",Menlo,monospace;letter-spacing:.1em;text-transform:uppercase;color:#b4b4b4;display:flex;align-items:center;gap:6px;margin-bottom:8px}' +
    '.tag i{width:7px;height:7px;border-radius:50%;background:var(--r);animation:pulse 1.8s infinite}' +
    '.title{margin:0;font:900 28px/.95 "Barlow Condensed","Arial Narrow",Impact,sans-serif;text-transform:uppercase;letter-spacing:.005em}' +
    '.body{margin:8px 0 0;color:#b4b4b4;font-size:15px}.handle{font-family:ui-monospace,Menlo,monospace;color:#f4f4f4}' +
    '.cta{position:relative;overflow:hidden;display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:44px;margin-top:14px;padding:0 20px;border-radius:999px;background:var(--r);color:#0a0a0a;font-weight:700;font-size:15px;text-decoration:none;transition:transform .15s,background .15s}' +
    '.cta:hover{background:var(--r2);transform:translateY(-1px)}.cta:active{transform:scale(.97)}' +
    '.cta::after{content:"";position:absolute;inset:0;background:linear-gradient(105deg,transparent 35%,rgba(255,255,255,.55) 50%,transparent 65%);transform:translateX(-120%);animation:shine 3.4s infinite}' +
    '.x{position:absolute;z-index:2;top:8px;right:8px;width:44px;height:44px;border:0;border-radius:50%;background:transparent;color:#b4b4b4;cursor:pointer;display:grid;place-items:center;transition:background .15s,color .15s}' +
    '.x:hover{background:rgba(255,255,255,.1);color:#fff}.x svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round}' +
    'a:focus-visible,button:focus-visible{outline:3px solid #fff;outline-offset:2px}' +
    '.media{position:relative;height:120px;background:#1a0505 center/cover no-repeat}.media img{width:100%;height:100%;object-fit:cover;display:block}' +
    '.media::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,transparent 40%,#0f0f0f)}' +
    '.pop{position:fixed;z-index:2147483000}' +
    '.corner{right:20px;bottom:20px;width:min(380px,calc(100vw - 40px));animation:up .5s cubic-bezier(.16,1,.3,1)}' +
    '.banner{left:0;right:0;bottom:0;padding:0 12px 12px;animation:up .5s cubic-bezier(.16,1,.3,1)}.banner .card{max-width:760px;margin:0 auto}' +
    '.back{position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;padding:16px;background:rgba(0,0,0,.66);animation:fade .25s}' +
    '.back .card{width:min(460px,100%);animation:pop .4s cubic-bezier(.16,1,.3,1)}.back .title{font-size:40px}' +
    '.inline{display:block;margin:0 auto;max-width:100%}.inline.small{width:320px}.inline.medium{width:300px}.inline.large{width:min(720px,100%)}' +
    '.inline.small .row{padding:12px}.inline.small .ico{width:40px;height:40px}.inline.small .title{font-size:24px}.inline.small .body{display:none}.inline.small .cta{min-height:44px;margin-top:8px}' +
    '.inline.large .media{height:200px}.inline.large .title{font-size:44px}' +
    '@media (max-width:639px){.corner{right:0;left:0;bottom:0;width:100%;padding:0 8px calc(8px + env(safe-area-inset-bottom))}.back{place-items:end center;padding:8px 8px calc(8px + env(safe-area-inset-bottom))}.back .title{font-size:34px}.title{font-size:26px}.inline.large .title{font-size:34px}}' +
    '@keyframes up{from{opacity:0;transform:translateY(28px)}to{opacity:1;transform:none}}' +
    '@keyframes pop{from{opacity:0;transform:translateY(16px) scale(.96)}to{opacity:1;transform:none}}' +
    '@keyframes fade{from{opacity:0}to{opacity:1}}' +
    '@keyframes shine{0%,55%{transform:translateX(-120%)}100%{transform:translateX(120%)}}' +
    '@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(255,59,63,.7)}70%,100%{box-shadow:0 0 0 8px transparent}}' +
    '@keyframes bob{0%,100%{transform:translateY(0) rotate(0)}50%{transform:translateY(-3px) rotate(-3deg)}}' +
    '@keyframes drift{to{transform:translateX(45%)}}' +
    '@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}';

  function el(tag, cls, txt) { var n = document.createElement(tag); if (cls) n.className = cls; if (txt != null) n.textContent = txt; return n; }
  function safeUrl(u) { return typeof u === 'string' && /^https:\/\//i.test(u) ? u : ''; }
  function imageUrl(u) { if (!u) return ''; if (u.charAt(0) === '/') return api + u; return safeUrl(u); }
  var LABEL = { en: { community: 'Community', follow: 'Follow', ad: 'Ad', official: 'Monocross', close: 'Close' }, pt: { community: 'Comunidade', follow: 'Siga', ad: 'Anúncio', official: 'Monocross', close: 'Fechar' } };
  function t(k) { return (LABEL[lang] || LABEL.en)[k]; }

  function build(c, onClose) {
    var card = el('div', 'card');
    var url = safeUrl(c.url);
    var img = imageUrl(c.image);
    if (img && (c.placement === 'inline' && c.size !== 'small')) {
      var media = el('div', 'media');
      var im = el('img'); im.src = img; im.alt = ''; im.loading = 'lazy'; im.decoding = 'async'; im.referrerPolicy = 'no-referrer';
      media.appendChild(im); card.appendChild(media);
    }
    var row = el('div', 'row');
    var ico = el('div', 'ico'); ico.innerHTML = ICONS[c.template] || ICONS.promo; // static strings from this file only
    var txt = el('div', 'txt');
    var tag = el('div', 'tag'); tag.appendChild(el('i'));
    tag.appendChild(document.createTextNode(c.kind === 'ad' ? t('ad') : c.template === 'tiktok' ? t('follow') : c.template === 'discord' ? t('community') : t('official')));
    var title = el('h2', 'title', c.title); title.id = 'mx-t-' + c.id;
    txt.appendChild(tag); txt.appendChild(title);
    if (c.body) {
      var body = el('p', 'body', c.body);
      if (c.handle && c.body.indexOf(c.handle) !== -1) {
        var parts = c.body.split(c.handle); body.textContent = '';
        body.appendChild(document.createTextNode(parts[0])); body.appendChild(el('span', 'handle', c.handle)); body.appendChild(document.createTextNode(parts.slice(1).join(c.handle)));
      }
      txt.appendChild(body);
    }
    if (url) {
      var a = el('a', 'cta', c.cta); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer' + (c.kind === 'ad' ? ' sponsored' : '');
      a.addEventListener('click', function () { remember(c.id, 'clicked'); track(c, 'click'); });
      txt.appendChild(a);
    }
    row.appendChild(ico); row.appendChild(txt);
    card.appendChild(row);
    var x = el('button', 'x'); x.type = 'button'; x.setAttribute('aria-label', t('close'));
    x.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    x.addEventListener('click', onClose);
    card.appendChild(x);
    return { card: card, close: x, cta: card.querySelector('.cta') };
  }

  function mount() {
    var host = el('div'); host.setAttribute('data-monocross-embed', '');
    var root = host.attachShadow({ mode: 'open' });
    var style = el('style', null, CSS); root.appendChild(style);
    return { host: host, root: root };
  }

  function showPopup(c) {
    var m = mount();
    var opener = document.activeElement;
    var done = false;
    function close(why) {
      if (done) return; done = true;
      document.removeEventListener('keydown', onKey, true);
      if (why !== 'click') { remember(c.id, 'closed'); track(c, 'close'); }
      m.host.remove();
      if (modal && opener && opener.focus) try { opener.focus(); } catch (e) { /* ignore */ }
    }
    var modal = c.placement === 'modal';
    var parts = build(c, function () { close('x'); });
    var wrap;
    if (modal) {
      wrap = el('div', 'back');
      parts.card.setAttribute('role', 'dialog'); parts.card.setAttribute('aria-modal', 'true'); parts.card.setAttribute('aria-labelledby', 'mx-t-' + c.id);
      wrap.addEventListener('click', function (e) { if (e.target === wrap) close('x'); });
    } else {
      wrap = el('div', 'pop ' + (c.placement === 'banner' ? 'banner' : 'corner'));
      parts.card.setAttribute('role', 'region'); parts.card.setAttribute('aria-labelledby', 'mx-t-' + c.id);
    }
    wrap.appendChild(parts.card); m.root.appendChild(wrap);
    function onKey(e) {
      if (e.key === 'Escape' && (modal || m.root.activeElement)) { close('x'); return; }
      if (modal && e.key === 'Tab') {
        var f = [parts.cta, parts.close].filter(Boolean);
        var i = f.indexOf(m.root.activeElement);
        e.preventDefault();
        f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
      }
    }
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(m.host);
    if (modal) (parts.cta || parts.close).focus();
    bumpSession(); track(c, 'impression');
  }

  function showInline(c, slot) {
    var m = mount();
    var parts = build(c, function () { remember(c.id, 'closed'); track(c, 'close'); m.host.remove(); });
    var wrap = el('div', 'inline ' + c.size);
    parts.card.setAttribute('role', 'complementary'); parts.card.setAttribute('aria-labelledby', 'mx-t-' + c.id);
    wrap.appendChild(parts.card); m.root.appendChild(wrap);
    slot.appendChild(m.host);
    var fired = false;
    function fire() { if (!fired) { fired = true; track(c, 'impression'); } }
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (es) { if (es[0].isIntersecting) { fire(); io.disconnect(); } }, { threshold: 0.5 });
      io.observe(m.host);
    } else fire();
  }

  // ---------- scheduling ----------
  function whenReady(c, go) {
    var f = c.frequency, start = Date.now(), tries = 0;
    function ready() {
      if (document.hidden) return false;
      if (Date.now() - start < f.delay_ms) return false;
      if (f.scroll_pct > 0) {
        var max = document.documentElement.scrollHeight - window.innerHeight;
        if (max > 0 && (window.scrollY / max) * 100 < f.scroll_pct) return false;
      }
      return true;
    }
    (function tick() {
      if (ready()) {
        // Never stack on top of another dialog or lightbox the page has open.
        if (document.querySelector('dialog[open]') && tries++ < 15) return setTimeout(tick, 2000);
        return go();
      }
      setTimeout(tick, 500);
    })();
  }

  function run(list) {
    var slots = [].slice.call(document.querySelectorAll('[data-monocross-slot]'));
    var inlines = list.filter(function (c) { return c.placement === 'inline' && !hidden(c); });
    slots.forEach(function (slot) {
      var want = slot.getAttribute('data-size');
      var c = inlines.filter(function (x) { return !want || x.size === want; })[0];
      if (c) { inlines.splice(inlines.indexOf(c), 1); showInline(c, slot); }
    });
    var pop = list.filter(function (c) { return c.placement !== 'inline' && !hidden(c) && sessionCount() < c.frequency.session_cap; })[0];
    if (pop) whenReady(pop, function () { if (sessionCount() < pop.frequency.session_cap) showPopup(pop); });
  }

  function start() {
    if (consentRequired && window.MonocrossConsent !== true) return;
    var ctl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 6000);
    var body = { site: site, token: token, path: location.pathname, lang: lang, device: device() };
    fetch(api + '/api/serve', { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: JSON.stringify(body), credentials: 'omit', signal: ctl ? ctl.signal : undefined })
      .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then(function (d) { clearTimeout(timer); if (d && Array.isArray(d.campaigns)) run(d.campaigns.slice(0, 5)); })
      .catch(function () { /* the page works fine without ads */ });
  }

  window.MonocrossEmbed = { reset: function () { try { localStorage.removeItem(KEY); sessionStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ } } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
