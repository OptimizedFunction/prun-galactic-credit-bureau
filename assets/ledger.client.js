// Spreadsheet-style editing for the Ledger page. Plain DOM, no framework.
// Served at /ledger.js; the page embeds its data as JSON in #ledger-data.
(() => {
  const boot = JSON.parse(document.getElementById('ledger-data').textContent);
  const user = boot.user;
  let loans = boot.loans;
  const byId = new Map(loans.map((l) => [l.id, l]));

  const STATUS = { in_progress: 'In Progress', complete: 'Complete', overdue: 'Overdue', breached: 'Breached', terminated: 'Terminated', stale: 'Stale' };
  const COLS = [
    { f: 'lender', label: 'Lender' },
    { f: 'borrower', label: 'Borrower' },
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

  let msgTimer;
  function say(text, isError) {
    msgEl.textContent = text;
    msgEl.className = isError ? 'err' : 'ok';
    clearTimeout(msgTimer);
    if (!isError) msgTimer = setTimeout(() => (msgEl.textContent = ''), 3000);
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
      err.loan = data.loan;
      throw err;
    }
    return data;
  }

  function fillRow(tr, loan) {
    tr.textContent = '';
    tr.dataset.id = loan.id;
    tr.className = loan.autoTrack ? 'tracked' : '';
    const text = [];
    for (const col of COLS) {
      const td = document.createElement('td');
      td.dataset.f = col.f;
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

  function applyFilter() {
    const words = filterBox.value.toLowerCase().split(/\s+/).filter(Boolean);
    let visible = 0;
    for (const tr of table.tBodies[0].rows) {
      const match = words.every((w) => tr.dataset.t.includes(w));
      tr.hidden = !match;
      if (match) visible++;
    }
    countEl.textContent = words.length ? `${visible.toLocaleString()} of ${loans.length.toLocaleString()} loans` : `${loans.length.toLocaleString()} loans`;
  }

  function render() {
    const body = document.createElement('tbody');
    for (const loan of loans) {
      const tr = document.createElement('tr');
      fillRow(tr, loan);
      body.append(tr);
    }
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
        const dir = sort && sort.f === col.f && sort.dir === 1 ? -1 : 1;
        sort = { f: col.f, dir };
        const key = (l) => (col.num ? Number(l[col.f] ?? -1) : String(l[col.f] ?? '').toLowerCase());
        loans.sort((a, b) => (key(a) < key(b) ? -dir : key(a) > key(b) ? dir : b.id - a.id));
        for (const other of tr.cells) other.removeAttribute('aria-sort');
        th.setAttribute('aria-sort', dir === 1 ? 'ascending' : 'descending');
        render();
      });
      if (col.num) th.classList.add('num');
      th.append(btn);
      tr.append(th);
    }
    tr.append(document.createElement('th'));
  }

  /** `expected` holds the values this browser was showing, so the server can refuse if someone changed them meanwhile. */
  async function save(loan, tr, patch, expected) {
    try {
      const data = await call('PATCH', '/api/v1/loans/' + loan.id, { ...patch, expected });
      Object.assign(loan, flat(data.loan));
      fillRow(tr, loan);
      applyFilter();
      if (data.changed.length) say('Saved.');
      return true;
    } catch (err) {
      if (err.loan && !err.loan.deletedAt) Object.assign(loan, flat(err.loan));
      fillRow(tr, loan);
      applyFilter();
      say(err.message, true);
      return false;
    }
  }

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
      if (cell.tabIndex === 0 && cell.dataset.f) return cell;
    }
  }

  function edit(td) {
    const tr = td.parentElement;
    const loan = byId.get(Number(tr.dataset.id));
    const col = COLS.find((c) => c.f === td.dataset.f);
    if (!loan || !col || col.check || !canEdit(loan, col) || td.querySelector('input,select')) return;

    const before = raw(loan, col);
    let input;
    if (col.options) {
      input = document.createElement('select');
      for (const [value, label] of col.options) input.add(new Option(label, value));
    } else {
      input = document.createElement('input');
      input.type = col.date ? 'date' : 'text';
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
      const where = target ? { id: target.parentElement.dataset.id, f: target.dataset.f } : null;
      if (commit && value !== before) await save(loan, tr, { [col.f]: value === '' ? null : value }, { [col.f]: before === '' ? null : before });
      else fillRow(tr, loan);
      if (where) {
        // The row may have been redrawn, so find the target cell again.
        const cell = table.querySelector(`tr[data-id="${where.id}"] td[data-f="${where.f}"]`);
        if (cell && cell.tabIndex === 0) edit(cell);
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') finish(true, 0);
      else if (e.key === 'Escape') finish(false, 0);
      else if (e.key === 'Tab') {
        e.preventDefault();
        finish(true, e.shiftKey ? -1 : 1);
      }
    });
    input.addEventListener('blur', () => finish(true, 0));
    if (col.options) input.addEventListener('change', () => finish(true, 0));
  }

  table.addEventListener('click', async (e) => {
    const tr = e.target.closest('tbody tr');
    if (!tr) return;
    const loan = byId.get(Number(tr.dataset.id));
    if (e.target.dataset.del) {
      if (!confirm(`Delete the loan from ${loan.lender} to ${loan.borrower}? It can be restored from Recent changes.`)) return;
      try {
        await call('DELETE', '/api/v1/loans/' + loan.id);
        loans = loans.filter((l) => l !== loan);
        byId.delete(loan.id);
        tr.remove();
        applyFilter();
        say('Deleted. You can restore it from Recent changes.');
      } catch (err) {
        say(err.message, true);
      }
      return;
    }
    const td = e.target.closest('td[data-f]');
    if (td && e.target === td) edit(td);
  });
  table.addEventListener('change', (e) => {
    if (e.target.type !== 'checkbox') return;
    const tr = e.target.closest('tr');
    save(byId.get(Number(tr.dataset.id)), tr, { autoTrack: e.target.checked }, { autoTrack: !e.target.checked });
  });
  table.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === 'F2') && e.target.matches('td[data-f]')) {
      e.preventDefault();
      edit(e.target);
    }
  });
  filterBox.addEventListener('input', applyFilter);

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
        const tr = document.createElement('tr');
        fillRow(tr, loan);
        table.tBodies[0].prepend(tr);
        applyFilter();
        addForm.reset();
        say('Loan added.');
      } catch (err) {
        say(err.message, true);
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
    if (document.hidden || refreshing) return;
    refreshing = true;
    try {
      const res = await fetch('/api/v1/updates?since=' + encodeURIComponent(cursor));
      if (!res.ok) return;
      const data = await res.json();
      cursor = data.cursor;
      let updated = 0;
      for (const incoming of data.loans) {
        const have = byId.get(incoming.id);
        const tr = have ? table.querySelector(`tr[data-id="${incoming.id}"]`) : null;
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
          const row = document.createElement('tr');
          fillRow(row, next);
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

  header();
  render();
  const wanted = new URLSearchParams(location.search).get('q');
  if (wanted) {
    filterBox.value = wanted;
    applyFilter();
  }
})();
