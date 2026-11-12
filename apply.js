// Application page: builds the role, language and tool pickers, checks the fields, asks for the terms, then sends.
const $ = selector => document.querySelector(selector);
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Studio application form: builds the pickers from /api/apply, checks the fields, asks for the terms, then sends.
(() => {
  const form = $('#applyForm');
  const status = $('#applyStatus');
  const submitButton = $('#applySubmit');
  const dialog = $('#termsDialog');
  const agree = $('#termsAgree');
  const confirmButton = $('#termsSubmit');
  let termsVersion = '';

  const setStatus = (message, isError = false) => {
    status.textContent = message;
    status.classList.toggle('is-error', isError);
  };
  const fieldFor = key => form.querySelector(`[data-field="${key}"]`);
  const setError = (key, message) => {
    const wrap = fieldFor(key);
    if (!wrap) return;
    const error = wrap.querySelector('.field-error');
    if (error) { error.textContent = message; error.hidden = false; }
    const control = wrap.querySelector('input, textarea');
    if (control) control.setAttribute('aria-invalid', 'true');
    wrap.classList.add('is-invalid');
    const details = wrap.closest('details');
    if (details) details.open = true; // open optional sections that hold an error
  };
  const clearError = key => {
    const wrap = fieldFor(key);
    if (!wrap) return;
    const error = wrap.querySelector('.field-error');
    if (error) { error.textContent = ''; error.hidden = true; }
    const control = wrap.querySelector('input, textarea');
    if (control) control.removeAttribute('aria-invalid');
    wrap.classList.remove('is-invalid');
  };

  // One grouped, searchable set of chips. Each chip wraps a real checkbox, so keyboard and screen reader support come for free.
  const buildPicker = (root, name, groups, label) => {
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'pick-search';
    search.placeholder = `Filter ${label.toLowerCase()}`;
    search.setAttribute('aria-label', `Filter ${label.toLowerCase()}`);
    root.append(search);
    const chips = [];
    const wraps = [];
    groups.forEach(group => {
      const wrap = el('div', 'pick-group-wrap');
      if (group.group) wrap.append(el('h4', 'pick-group', group.group));
      const list = el('div', 'pick-list');
      const groupChips = group.items.map(item => {
        const chip = el('label', 'pick-chip');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.name = name;
        box.value = item;
        box.addEventListener('change', () => chip.classList.toggle('is-on', box.checked));
        chip.append(box, el('span', '', item));
        list.append(chip);
        return { chip, text: item };
      });
      chips.push(...groupChips);
      wrap.append(list);
      root.append(wrap);
      wraps.push({ wrap, groupChips });
    });
    search.addEventListener('input', () => {
      const query = search.value.trim().toLowerCase();
      chips.forEach(({ chip, text }) => { chip.hidden = Boolean(query) && !text.toLowerCase().includes(query); });
      wraps.forEach(({ wrap, groupChips }) => { wrap.hidden = groupChips.every(({ chip }) => chip.hidden); });
    });
  };

  const syncChips = () => {
    form.querySelectorAll('.pick-chip').forEach(chip => {
      chip.classList.toggle('is-on', chip.querySelector('input').checked);
    });
  };
  const isHttps = value => {
    try { return new URL(value).protocol === 'https:'; } catch (err) { return false; }
  };

  // Returns the first invalid control so the page can focus it. Checks run in the same order as the form.
  const validate = () => {
    const data = new FormData(form);
    const text = key => String(data.get(key) || '').trim();
    const portfolio = text('portfolio');
    const checks = [
      ['name', !text('name'), 'Enter your name.'],
      ['email', !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text('email')), 'Enter a valid email address.'],
      ['roles', !data.getAll('roles').length, 'Pick at least one role.'],
      ['languages', !data.getAll('languages').length, 'Pick at least one language.'],
      ['availability', !text('availability'), 'Tell us when and how much you can work.'],
      ['portfolio', Boolean(portfolio) && !isHttps(portfolio), 'Use a full https:// link.'],
    ];
    let firstInvalid = null;
    checks.forEach(([key, failed, message]) => {
      if (failed) {
        setError(key, message);
        firstInvalid = firstInvalid || fieldFor(key).querySelector('input, textarea');
      } else {
        clearError(key);
      }
    });
    return firstInvalid;
  };

  const loadOptions = async () => {
    try {
      const response = await fetch('/api/apply', { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('options unavailable');
      const data = await response.json();
      termsVersion = data.termsVersion;
      buildPicker($('#rolesPicker'), 'roles', data.options.roles, 'Roles');
      buildPicker($('#languagesPicker'), 'languages', data.options.languages, 'Languages');
      buildPicker($('#toolsPicker'), 'tools', data.options.tools, 'Tools');
      submitButton.disabled = false;
    } catch (err) {
      setStatus('The form could not load. Refresh the page to try again.', true);
    }
  };

  form.addEventListener('input', event => {
    if (event.target.classList.contains('pick-search')) return;
    const wrap = event.target.closest('[data-field]');
    if (wrap) clearError(wrap.dataset.field);
  });
  form.addEventListener('change', event => {
    const wrap = event.target.closest('[data-field]');
    if (wrap) clearError(wrap.dataset.field);
  });
  form.addEventListener('reset', () => {
    // form.reset() runs after this event, so the reset work waits one tick.
    setTimeout(() => {
      syncChips();
      form.querySelectorAll('.pick-search').forEach(search => search.dispatchEvent(new Event('input')));
      form.querySelectorAll('[data-field]').forEach(wrap => clearError(wrap.dataset.field));
    }, 0);
  });

  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!termsVersion) return;
    const firstInvalid = validate();
    if (firstInvalid) {
      setStatus('Check the highlighted fields.', true);
      firstInvalid.focus();
      return;
    }
    setStatus('');
    // The box starts unchecked every time. Nothing is sent until the person agrees in the dialog.
    agree.checked = false;
    confirmButton.disabled = true;
    dialog.showModal();
    agree.focus();
  });

  agree.addEventListener('change', () => { confirmButton.disabled = !agree.checked; });
  confirmButton.addEventListener('click', async () => {
    if (!agree.checked) return;
    confirmButton.disabled = true;
    confirmButton.textContent = 'Sending…';
    const data = new FormData(form);
    const text = key => String(data.get(key) || '');
    const payload = {
      name: text('name'),
      email: text('email'),
      roles: data.getAll('roles'),
      languages: data.getAll('languages'),
      tools: data.getAll('tools'),
      otherTools: text('otherTools'),
      portfolio: text('portfolio'),
      experience: text('experience'),
      availability: text('availability'),
      notes: text('notes'),
      website: text('website'),
      terms: { accepted: agree.checked === true, version: termsVersion },
    };
    try {
      const response = await fetch('/api/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'The application could not be sent.');
      dialog.close();
      form.reset();
      setStatus('Thanks. Your application is in. We will reply by email.');
    } catch (err) {
      dialog.close();
      setStatus(err.message, true);
    } finally {
      confirmButton.textContent = 'I Agree & Submit';
    }
  });

  loadOptions();
})();
