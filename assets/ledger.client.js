// Spreadsheet-style editing for the Ledger page. Plain DOM, no framework.
// Served at /ledger.js; the page embeds its first rows as JSON in #ledger-data and the rest are fetched.
(() => {
  const boot = JSON.parse(document.getElementById('ledger-data').textContent);
  // On a small screen the ledger is read-only, so a stray tap cannot change a loan.
  const small = window.matchMedia('(max-width: 760px)').matches;
  const user = small ? null : boot.user;
  let loans = boot.loans;
  const byId = new Map(loans.map((l) => [l.id, l]));
  /** False until every loan has arrived; the page starts with the newest ones only. */
  let complete = loans.length >= boot.total;

  const STATUS = { in_progress: 'In Progress', complete: 'Complete', overdue: 'Overdue', breached: 'Breached', terminated: 'Terminated', stale: 'Stale' };
  const COLS = [
    { f: 'lender', label: 'Lender', names: 'names-lender' },
    { f: 'borrower', label: 'Borrower', names: 'names-borrower' },
    { f: 'companyCode', label: 'CO' },
    { f: 'corpCode', label: 'CORP' },
    { f: 'principal', label: 'Amount', num: true },
    { f: 'currency', label: 'Currency', options: [['AIC', 'AIC'], ['CIS', 'CIS'], ['ICA', 'ICA'], ['NCC', 'NCC'], ['', 'N/A']] },
    { f: 'issuedOn', label: 'Issued', date: true },
    { f: 'durationWeeks', label: 'Weeks', num: true },
    { f: 'status', label: 'Status', options: Object.entries(STATUS) },
    { f: 'contractId', label: 'Contract' },
    { f: 'autoTrack', label: 'Auto track', check: true },
    // Set by the bureau: FIO-verified by the sync, Community-edited when someone changes a loan's facts.
    { f: 'trust', label: 'Trust', readonly: true },
    { f: 'notes', label: 'Notes', wide: true },
  ];
  const TRUST = { fio_verified: 'FIO-verified', lender_reported: 'Lender-reported', community_edited: 'Community-edited' };
  /** Cells that stay editable on a loan the FIO sync manages. */
  const TRACKED_EDITABLE = ['notes', 'autoTrack'];

  const table = document.getElementById('ledger');
  const filterBox = document.getElementById('ledger-filter');
  const countEl = document.getElementById('ledger-count');
  const msgEl = document.getElementById('ledger-msg');
  const toastEl = document.getElementById('ledger-toast');
  let sort = null;

  const commas = (whole) => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  /** Value as typed into an editor. */
  const raw = (loan, col) => {
    const v = loan[col.f];
    if (v === null || v === undefined) return '';
    if (col.f === 'principal') return String(v).replace(/\.00$/, '');
    return String(v);
  };
  /** Value as shown in a cell. */
  const shown = (loan, col) => {
    const v = loan[col.f];
    if (col.f === 'currency') return v ?? 'N/A';
    if (v === null || v === undefined) return '';
    if (col.f === 'principal') {
      const [whole, frac] = String(v).split('.');
      return commas(whole) + (frac && frac !== '00' ? '.' + frac : '');
    }
    if (col.f === 'durationWeeks') return String(Math.round(v * 100) / 100);
    if (col.f === 'status') return STATUS[v] ?? v;
    if (col.f === 'trust') return TRUST[v] ?? v;
    return String(v);
  };
  const canEdit = (loan, col) => Boolean(user) && !col.readonly && (!loan.autoTrack || TRACKED_EDITABLE.includes(col.f));
  const cellOf = (id, f) => table.querySelector(`tr[data-id="${id}"] td[data-f="${f}"]`);
  const rowOf = (id) => table.querySelector(`tr[data-id="${id}"]`);

  /** API loan -> the flat shape the ledger uses. */
  const flat = (l) => ({
    id: l.id,
    lender: l.lender,
    borrower: l.borrower.username,
    companyCode: l.borrower.companyCode,
    corpCode: l.borrower.corpCode,
    principal: l.principal,
    currency: l.currency,
    issuedOn: l.issuedOn,
    durationWeeks: l.durationWeeks,
    status: l.status,
    contractId: l.contractId,
    autoTrack: l.autoTrack,
    notes: l.notes,
    trust: l.trust,
  });

  // ---- Messages ----

  /** A line in the toolbar, for things that are not about one cell (other people's updates, loading). */
  let msgTimer;
  function say(text, isError) {
    msgEl.textContent = text;
    msgEl.className = isError ? 'err' : 'ok';
    clearTimeout(msgTimer);
    if (!isError) msgTimer = setTimeout(() => (msgEl.textContent = ''), 4000);
  }

  /**
   * A small message next to the cell or row it is about, optionally with one action (Undo, Use mine).
   * It stays for a few seconds, or until the next one replaces it.
   */
  let toastTimer;
  function toast(anchor, text, options = {}) {
    clearTimeout(toastTimer);
    toastEl.textContent = '';
    toastEl.className = options.error ? 'err' : '';
    const words = document.createElement('span');
    words.textContent = text;
    toastEl.append(words);
    if (options.action) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = options.action.label;
      button.addEventListener('click', () => {
        hideToast();
        options.action.run();
      });
      toastEl.append(button);
    }
    toastEl.hidden = false;
    const box = anchor && anchor.isConnected ? anchor.getBoundingClientRect() : null;
    const width = toastEl.offsetWidth;
    const height = toastEl.offsetHeight;
    const left = box ? Math.min(Math.max(box.left, 8), window.innerWidth - width - 8) : (window.innerWidth - width) / 2;
    const below = box ? box.bottom + 6 : window.innerHeight - height - 16;
    toastEl.style.left = left + 'px';
    toastEl.style.top = Math.min(Math.max(below, 8), window.innerHeight - height - 8) + 'px';
    toastTimer = setTimeout(hideToast, options.error || options.action ? 8000 : 2500);
  }
  function hideToast() {
    clearTimeout(toastTimer);
    toastEl.hidden = true;
  }

  async function call(method, url, body) {
    let res;
    try {
      res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    } catch {
      throw new Error('Could not reach the server.');
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) throw new Error('Your sign-in has expired. Reload the page and sign in again.');
    if (!res.ok) {
      const err = new Error(data.error?.message ?? `Request failed (${res.status}).`);
      // A conflict comes with the loan as it is now.
      err.conflict = res.status === 409;
      err.loan = data.loan;
      throw err;
    }
    return data;
  }

  // ---- Drawing ----

  function fillRow(tr, loan) {
    tr.textContent = '';
    tr.dataset.id = loan.id;
    tr.className = loan.autoTrack ? 'tracked' : '';
    const text = [];
    for (const col of COLS) {
      const td = document.createElement('td');
      td.dataset.f = col.f;
      td.dataset.label = col.label;
      if (col.num) td.classList.add('num');
      if (col.wide) td.classList.add('wrap');
      if (col.check) {
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = loan.autoTrack;
        box.disabled = !user;
        box.setAttribute('aria-label', 'Auto track');
        td.append(box);
      } else {
        td.textContent = shown(loan, col);
        text.push(td.textContent);
        if (col.readonly) {
          td.classList.add('readonly', 'tr-' + loan.trust);
          td.title = 'Set by the bureau. It changes when a loan is edited or checked against FIO.';
        } else if (canEdit(loan, col)) td.tabIndex = 0;
        else if (user) {
          td.classList.add('locked');
          td.title = 'Kept up to date from FIO. Untick Auto track to edit.';
        }
        if (col.f === 'status') td.classList.add('st-' + loan.status);
      }
      tr.append(td);
    }
    const last = document.createElement('td');
    last.className = 'row-actions';
    const link = document.createElement('a');
    link.href = '/loans/' + loan.id;
    link.textContent = 'History';
    last.append(link);
    if (user && !loan.autoTrack) {
      const del = document.createElement('button');
      del.type = 'button';
      del.dataset.del = '1';
      del.textContent = 'Delete';
      last.append(' ', del);
    }
    tr.append(last);
    tr.dataset.t = text.join(' ').toLowerCase();
  }

  function newRow(loan) {
    const tr = document.createElement('tr');
    fillRow(tr, loan);
    return tr;
  }

  function applyFilter() {
    const words = filterBox.value.toLowerCase().split(/\s+/).filter(Boolean);
    let visible = 0;
    for (const tr of table.tBodies[0].rows) {
      const match = words.every((w) => tr.dataset.t.includes(w));
      tr.hidden = !match;
      if (match) visible++;
    }
    const total = (complete ? loans.length : boot.total).toLocaleString();
    countEl.textContent = (words.length ? `${visible.toLocaleString()} of ${total} loans` : `${total} loans`) + (complete ? '' : ' (loading the rest…)');
  }

  function sortLoans() {
    if (!sort) return;
    const col = COLS.find((c) => c.f === sort.f);
    const key = (l) => (col.num ? Number(l[col.f] ?? -1) : String(l[col.f] ?? '').toLowerCase());
    loans.sort((a, b) => (key(a) < key(b) ? -sort.dir : key(a) > key(b) ? sort.dir : b.id - a.id));
  }

  function render() {
    const body = document.createElement('tbody');
    for (const loan of loans) body.append(newRow(loan));
    table.tBodies[0].replaceWith(body);
    applyFilter();
  }

  function header() {
    const tr = table.tHead.rows[0];
    for (const col of COLS) {
      const th = document.createElement('th');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = col.label;
      btn.title = 'Sort by ' + col.label;
      btn.addEventListener('click', () => {
        sort = { f: col.f, dir: sort && sort.f === col.f && sort.dir === 1 ? -1 : 1 };
        sortLoans();
        for (const other of tr.cells) other.removeAttribute('aria-sort');
        th.setAttribute('aria-sort', sort.dir === 1 ? 'ascending' : 'descending');
        render();
      });
      if (col.num) th.classList.add('num');
      th.append(btn);
      tr.append(th);
    }
    tr.append(document.createElement('th'));
  }

  /** Names already on record, offered while typing a lender or borrower so near-duplicates are not created. */
  function fillNames() {
    for (const [id, f] of [['names-lender', 'lender'], ['names-borrower', 'borrower']]) {
      const list = document.getElementById(id);
      if (!list) continue;
      const names = [...new Set(loans.map((l) => l[f]))].sort((a, b) => a.localeCompare(b));
      list.textContent = '';
      for (const name of names) list.append(new Option(name));
    }
  }

  // ---- Saving ----

  /**
   * Saves `patch` to a loan. `expected` holds the values this browser was showing, so the server can refuse
   * if someone changed them meanwhile. On success a toast by the cell offers Undo; on a conflict it shows
   * who changed what and offers to apply this edit on top.
   */
  async function save(loan, patch, expected, options = {}) {
    const field = Object.keys(patch)[0];
    const before = {};
    for (const f of Object.keys(patch)) before[f] = loan[f];
    const anchor = () => cellOf(loan.id, field) ?? rowOf(loan.id);
    const redraw = () => {
      const tr = rowOf(loan.id);
      if (tr) fillRow(tr, loan);
      applyFilter();
    };

    try {
      const data = await call('PATCH', '/api/v1/loans/' + loan.id, { ...patch, expected });
      Object.assign(loan, flat(data.loan));
      redraw();
      if (data.changed.length === 0) return true;
      const after = {};
      for (const f of Object.keys(patch)) after[f] = loan[f];
      toast(anchor(), options.undone ? 'Change undone.' : 'Saved.', options.undone ? {} : { action: { label: 'Undo', run: () => save(loan, before, after, { undone: true }) } });
      return true;
    } catch (err) {
      const current = err.loan && !err.loan.deletedAt ? flat(err.loan) : null;
      if (current) Object.assign(loan, current);
      redraw();
      // Someone else changed this very cell first: offer to put this edit on top of theirs, knowingly.
      const overwritable = err.conflict && current && /while you were editing/.test(err.message) && COLS.some((c) => c.f === field && canEdit(loan, c));
      const theirs = {};
      for (const f of Object.keys(patch)) theirs[f] = loan[f];
      toast(anchor(), err.message, { error: true, action: overwritable ? { label: 'Use mine instead', run: () => save(loan, patch, theirs) } : undefined });
      return false;
    }
  }

  // ---- Moving between cells ----

  const isCell = (el) => el && el.tabIndex === 0 && Boolean(el.dataset.f);

  /** The next editable cell reading left to right, then down (or the reverse). */
  function nextEditable(td, back) {
    let tr = td.parentElement;
    let cell = td;
    for (;;) {
      cell = back ? cell.previousElementSibling : cell.nextElementSibling;
      if (!cell) {
        do tr = back ? tr.previousElementSibling : tr.nextElementSibling;
        while (tr && tr.hidden);
        if (!tr) return null;
        cell = back ? tr.lastElementChild : tr.firstElementChild;
      }
      if (isCell(cell)) return cell;
    }
  }

  /** The editable cell in the same column of the next visible row up or down. */
  function cellInRow(td, up) {
    let tr = td.parentElement;
    for (;;) {
      do tr = up ? tr.previousElementSibling : tr.nextElementSibling;
      while (tr && tr.hidden);
      if (!tr) return null;
      const cell = tr.querySelector(`td[data-f="${td.dataset.f}"]`);
      if (isCell(cell)) return cell;
    }
  }

  function edit(td) {
    const tr = td.parentElement;
    const loan = byId.get(Number(tr.dataset.id));
    const col = COLS.find((c) => c.f === td.dataset.f);
    if (!loan || !col || col.check || !canEdit(loan, col) || td.querySelector('input,select')) return;
    hideToast();

    const before = raw(loan, col);
    let input;
    if (col.options) {
      input = document.createElement('select');
      for (const [value, label] of col.options) input.add(new Option(label, value));
    } else {
      input = document.createElement('input');
      input.type = col.date ? 'date' : 'text';
      if (col.names) input.setAttribute('list', col.names);
    }
    input.value = before;
    input.setAttribute('aria-label', col.label);
    td.textContent = '';
    td.append(input);
    input.focus();
    if (input.select) input.select();

    let done = false;
    const finish = async (commit, move) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      const target = move ? nextEditable(td, move < 0) : null;
      const where = target ? { id: target.parentElement.dataset.id, f: target.dataset.f } : { id: loan.id, f: col.f };
      const keepFocus = move !== null;
      if (commit && value !== before) await save(loan, { [col.f]: value === '' ? null : value }, { [col.f]: before === '' ? null : before });
      else fillRow(tr, loan);
      if (!keepFocus) return;
      // The row was redrawn, so find the cell again: the next one when tabbing, this one after Enter or Esc.
      const cell = cellOf(where.id, where.f);
      if (!isCell(cell)) return;
      if (target) edit(cell);
      else cell.focus();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true, 0);
      else if (e.key === 'Escape') finish(false, 0);
      else if (e.key === 'Tab') {
        e.preventDefault();
        finish(true, e.shiftKey ? -1 : 1);
      }
      // Keys typed in an editor are not for the grid.
      e.stopPropagation();
    });
    // Clicking away saves, but leaves focus wherever the click went.
    input.addEventListener('blur', () => finish(true, null));
    if (col.options) input.addEventListener('change', () => finish(true, 0));
  }

  table.addEventListener('click', async (e) => {
    const tr = e.target.closest('tbody tr');
    if (!tr) return;
    const loan = byId.get(Number(tr.dataset.id));
    if (e.target.dataset.del) {
      if (!confirm(`Delete the loan from ${loan.lender} to ${loan.borrower}?`)) return;
      const place = e.target.getBoundingClientRect();
      try {
        await call('DELETE', '/api/v1/loans/' + loan.id);
        loans = loans.filter((l) => l !== loan);
        byId.delete(loan.id);
        tr.remove();
        applyFilter();
        // The row is gone, so anchor the toast where the button was.
        toast({ isConnected: true, getBoundingClientRect: () => place }, 'Loan deleted.', {
          action: {
            label: 'Undo',
            run: async () => {
              try {
                const data = await call('POST', '/api/v1/loans/' + loan.id + '/restore');
                Object.assign(loan, flat(data.loan));
                loans.unshift(loan);
                byId.set(loan.id, loan);
                sortLoans();
                render();
                toast(rowOf(loan.id), 'Loan restored.');
              } catch (err) {
                toast(null, err.message, { error: true });
              }
            },
          },
        });
      } catch (err) {
        toast(e.target, err.message, { error: true });
      }
      return;
    }
    const td = e.target.closest('td[data-f]');
    if (td && e.target === td) edit(td);
  });
  table.addEventListener('change', (e) => {
    if (e.target.type !== 'checkbox') return;
    const tr = e.target.closest('tr');
    save(byId.get(Number(tr.dataset.id)), { autoTrack: e.target.checked }, { autoTrack: !e.target.checked });
  });
  // With a cell focused (not being edited): Enter or F2 edits it, arrow keys move around the grid.
  table.addEventListener('keydown', (e) => {
    const td = e.target;
    if (!td.matches || !td.matches('td[data-f]')) return;
    if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault();
      edit(td);
      return;
    }
    const to =
      e.key === 'ArrowRight' ? nextEditable(td, false) : e.key === 'ArrowLeft' ? nextEditable(td, true) : e.key === 'ArrowDown' ? cellInRow(td, false) : e.key === 'ArrowUp' ? cellInRow(td, true) : null;
    if (to) {
      e.preventDefault();
      to.focus();
    }
  });

  // The filter lives in the address bar too, so a filtered ledger can be bookmarked or shared.
  filterBox.addEventListener('input', () => {
    applyFilter();
    const url = new URL(location.href);
    if (filterBox.value.trim()) url.searchParams.set('q', filterBox.value.trim());
    else url.searchParams.delete('q');
    history.replaceState(null, '', url);
  });

  const addForm = document.getElementById('ledger-add');
  if (addForm) {
    addForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = {};
      for (const el of addForm.elements) {
        if (el.name) body[el.name] = el.value.trim() === '' ? null : el.value.trim();
      }
      try {
        const data = await call('POST', '/api/v1/loans', body);
        const loan = flat(data.loan);
        loans.unshift(loan);
        byId.set(loan.id, loan);
        const tr = newRow(loan);
        table.tBodies[0].prepend(tr);
        applyFilter();
        fillNames();
        addForm.reset();
        flash(tr);
        toast(tr, 'Loan added.');
      } catch (err) {
        toast(addForm.querySelector('button[type=submit]'), err.message, { error: true });
      }
    });
  }

  // ---- Background refresh: pick up other people's changes every 30 seconds while the tab is visible. ----
  let cursor = boot.cursor;
  let refreshing = false;
  function flash(tr) {
    tr.classList.add('flash');
    setTimeout(() => tr.classList.remove('flash'), 400);
  }
  async function refresh() {
    if (document.hidden || refreshing || !complete) return;
    refreshing = true;
    try {
      const res = await fetch('/api/v1/updates?since=' + encodeURIComponent(cursor));
      if (!res.ok) return;
      const data = await res.json();
      cursor = data.cursor;
      let updated = 0;
      for (const incoming of data.loans) {
        const have = byId.get(incoming.id);
        const tr = have ? rowOf(incoming.id) : null;
        if (incoming.deletedAt) {
          if (!have) continue;
          loans = loans.filter((l) => l !== have);
          byId.delete(incoming.id);
          if (tr) tr.remove();
          updated++;
          continue;
        }
        const next = flat(incoming);
        if (!have) {
          loans.unshift(next);
          byId.set(next.id, next);
          const row = newRow(next);
          table.tBodies[0].prepend(row);
          flash(row);
          updated++;
          continue;
        }
        if (JSON.stringify(have) === JSON.stringify(next)) continue;
        Object.assign(have, next);
        updated++;
        // A row with a cell open for editing is left alone; saving that cell will report the conflict if there is one.
        if (tr && !tr.querySelector('td input:not([type=checkbox]), td select')) {
          fillRow(tr, have);
          flash(tr);
        }
      }
      if (updated) {
        applyFilter();
        say(updated === 1 ? '1 loan was updated by someone else.' : `${updated} loans were updated by others.`);
      }
    } catch {
      // Offline or the server is restarting: try again on the next tick.
    } finally {
      refreshing = false;
    }
  }
  setInterval(refresh, 30000);
  document.addEventListener('visibilitychange', refresh);

  // ---- Loading the rest: the page arrives with the newest loans; older ones follow in the background. ----
  async function loadRest() {
    const pageSize = 500;
    try {
      for (let offset = loans.length; offset < boot.total; offset += pageSize) {
        // The cursor in the address keeps a cached copy from an earlier visit out of it.
        const res = await fetch(`/api/v1/loans?limit=${pageSize}&offset=${offset}&at=${encodeURIComponent(boot.cursor)}`);
        if (!res.ok) throw new Error('load failed');
        const data = await res.json();
        const fresh = data.loans.map(flat).filter((l) => !byId.has(l.id));
        for (const loan of fresh) byId.set(loan.id, loan);
        loans.push(...fresh);
        if (sort) {
          sortLoans();
          render();
        } else {
          const part = document.createDocumentFragment();
          for (const loan of fresh) part.append(newRow(loan));
          table.tBodies[0].append(part);
          applyFilter();
        }
        if (data.loans.length < pageSize) break;
      }
      complete = true;
      applyFilter();
      fillNames();
      // Anything edited while the older loans were arriving.
      refresh();
    } catch {
      say('Could not load every loan. Reload the page to try again.', true);
    }
  }

  header();
  render();
  fillNames();
  const wanted = new URLSearchParams(location.search).get('q');
  if (wanted) {
    filterBox.value = wanted;
    applyFilter();
  }
  if (!complete) loadRest();
})();
