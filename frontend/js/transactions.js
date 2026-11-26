// Transactions view (owner: [TEAMMATE 1]). Talks to /api/transactions/*.
const TransactionsView = {
  init() {
    const filter = document.getElementById('form-filter');
    const today = UI.today();
    filter.from.value = `${today.slice(0, 7)}-01`;
    filter.to.value = today;
    filter.addEventListener('submit', (e) => { e.preventDefault(); this.load(); });

    const form = document.getElementById('form-txn');
    form.date.value = today;
    form.currency.value = (UI.user() || {}).baseCurrency || 'EGP';
    form.addEventListener('submit', (e) => { e.preventDefault(); this.save(form); });
    form.addEventListener('change', (e) => {
      if (e.target.name === 'type') this.toggleType(form);
      if (e.target.name === 'currency') this.previewFx(form);
    });
    document.getElementById('txn-cancel').addEventListener('click', () => this.resetForm());
  },

  toggleType(form) {
    const isExpense = form.querySelector('input[name=type]:checked').value === 'expense';
    form.querySelector('.expense-only').classList.toggle('hidden', !isExpense);
  },

  async previewFx(form) {
    const p = document.getElementById('fx-preview');
    const base = (UI.user() || {}).baseCurrency;
    if (!base || form.currency.value === base) { p.textContent = ''; return; }
    try {
      const r = await Api.get('/api/transactions/fx-rate', { from: form.currency.value });
      p.textContent = `1 ${r.from} = ${r.rate.toFixed(4)} ${r.to} (${r.source})`;
    } catch (e) { p.textContent = e.message; }
  },

  setBuckets(buckets) {
    const opts = buckets.map((b) => ({ value: b.id, text: b.name }));
    for (const sel of [document.getElementById('form-txn').bucketId, document.getElementById('form-filter').bucketId]) {
      const keep = sel.value;
      const isFilter = sel.form.id === 'form-filter';
      UI.clear(sel);
      if (isFilter) sel.append(UI.el('option', { value: '', text: 'All' }));
      for (const o of opts) sel.append(UI.el('option', o));
      if (keep) sel.value = keep;
    }
  },

  async load() {
    const q = UI.formData(document.getElementById('form-filter'));
    try {
      const data = await Api.get('/api/transactions', q);
      const body = UI.clear(document.querySelector('#txn-table tbody'));
      if (!data.items.length) body.append(UI.el('tr', {}, UI.el('td', { colspan: 8, class: 'muted', text: 'No transactions in this range.' })));
      for (const t of data.items) {
        const amount = t.currency !== t.baseCurrency
          ? `${UI.money(t.amount, t.currency)} → ${UI.money(t.amountBase, t.baseCurrency)}`
          : UI.money(t.amount, t.currency);
        body.append(UI.el('tr', {},
          UI.el('td', { text: t.date }),
          UI.el('td', { class: t.type === 'income' ? 'income' : '', text: t.type }),
          UI.el('td', { class: 'num', text: amount }),
          UI.el('td', { text: t.bucketName || '-' }),
          UI.el('td', { text: t.paymentMethod.replace('_', ' ') }),
          UI.el('td', { text: t.note }),
          UI.el('td', {},
            t.hasReceipt ? UI.el('button', { class: 'link', text: 'View', onclick: () => this.viewReceipt(t) }) : null,
            UI.el('button', { class: 'link', text: t.hasReceipt ? 'Replace' : 'Attach', onclick: () => this.pickReceipt(t) })),
          UI.el('td', {},
            UI.el('button', { class: 'link', text: 'Edit', onclick: () => this.edit(t) }),
            UI.el('button', { class: 'link danger', text: 'Delete', onclick: () => this.remove(t) }))));
      }
      document.getElementById('txn-totals').textContent =
        `${data.total} transaction(s) · income ${UI.money(data.totals.income)} · expenses ${UI.money(data.totals.expense)} · net ${UI.money(data.totals.net, data.baseCurrency)}`;
    } catch (e) { UI.fail(e); }
  },

  edit(t) {
    const form = document.getElementById('form-txn');
    form.id.value = t.id;
    form.querySelector(`input[name=type][value=${t.type}]`).checked = true;
    form.amount.value = t.amount;
    form.currency.value = t.currency;
    form.date.value = t.date;
    form.date.disabled = true;
    form.querySelectorAll('input[name=type]').forEach((r) => { r.disabled = true; });
    if (t.bucketId) form.bucketId.value = t.bucketId;
    form.paymentMethod.value = t.paymentMethod;
    form.note.value = t.note;
    this.toggleType(form);
    document.getElementById('txn-form-title').textContent = 'Edit transaction';
    document.getElementById('txn-cancel').classList.remove('hidden');
  },

  resetForm() {
    const form = document.getElementById('form-txn');
    form.reset();
    form.id.value = '';
    form.date.disabled = false;
    form.querySelectorAll('input[name=type]').forEach((r) => { r.disabled = false; });
    form.date.value = UI.today();
    form.currency.value = (UI.user() || {}).baseCurrency || 'EGP';
    this.toggleType(form);
    document.getElementById('txn-form-title').textContent = 'Log a transaction';
    document.getElementById('txn-cancel').classList.add('hidden');
    document.getElementById('fx-preview').textContent = '';
  },

  async save(form) {
    const d = UI.formData(form);
    const type = form.querySelector('input[name=type]:checked').value;
    const out = document.getElementById('txn-budget');
    if (!(Number(d.amount) > 0)) { UI.toast('Enter an amount greater than 0.', true); return; }
    const body = { amount: Number(d.amount), currency: d.currency, paymentMethod: d.paymentMethod, note: d.note };
    if (type === 'expense') body.bucketId = d.bucketId;
    try {
      let res;
      if (d.id) {
        res = await Api.patch(`/api/transactions/${d.id}`, body);
      } else {
        res = await Api.post('/api/transactions', { ...body, type, date: d.date });
      }
      out.textContent = res.budget
        ? `"${res.transaction.bucketName}": ${UI.money(res.budget.spent)} of ${UI.money(res.budget.effectiveLimit)} used (${UI.pct(res.budget.percentUsed)}) · ${UI.stateLabel[res.budget.state]}`
        : '';
      UI.toast(res.alertRaised ? 'Saved, and a budget alert was raised.' : 'Saved.', res.alertRaised);
      this.resetForm();
      this.load();
    } catch (e) { UI.fail(e); }
  },

  // ----- Receipts (enhancement 5e, Salma) -----
  // The browser checks are only for a quick, friendly message. The real protection is on the
  // server: S3 refuses files over 5 MB or of another type, and the service checks the file's
  // first bytes before attaching it.
  receiptTypes: ['image/jpeg', 'image/png', 'application/pdf'],
  receiptMaxBytes: 5 * 1024 * 1024,

  pickReceipt(t) {
    const input = UI.el('input', { type: 'file', accept: this.receiptTypes.join(',') });
    input.addEventListener('change', () => { if (input.files[0]) this.uploadReceipt(t, input.files[0]); });
    input.click();
  },

  async uploadReceipt(t, file) {
    if (!this.receiptTypes.includes(file.type)) { UI.toast('Receipts must be a JPEG, PNG or PDF file.', true); return; }
    if (file.size > this.receiptMaxBytes) { UI.toast('Receipts can be at most 5 MB.', true); return; }
    try {
      // 1. Ask the service for an upload form (S3 will enforce the size and type)
      const form = await Api.post(`/api/transactions/${t.id}/receipt`, { contentType: file.type });
      // 2. Send the file straight to the private S3 bucket
      const data = new FormData();
      for (const [k, v] of Object.entries(form.fields)) data.append(k, v);
      data.append('file', file);
      const up = await fetch(form.uploadUrl, { method: 'POST', body: data });
      if (!up.ok) {
        UI.toast(up.status === 400 ? 'The storage refused the file (too large).' : 'The storage refused the file.', true);
        return;
      }
      // 3. Ask the service to check the file and attach it
      await Api.post(`/api/transactions/${t.id}/receipt/confirm`);
      UI.toast('Receipt attached.');
      this.load();
    } catch (e) { UI.fail(e); this.load(); }
  },

  async viewReceipt(t) {
    try {
      const r = await Api.get(`/api/transactions/${t.id}/receipt`);
      window.open(r.downloadUrl, '_blank', 'noopener');
    } catch (e) { UI.fail(e); }
  },

  async remove(t) {
    if (!window.confirm('Delete this transaction?')) return;
    try { await Api.del(`/api/transactions/${t.id}`); UI.toast('Transaction deleted.'); this.load(); } catch (e) { UI.fail(e); }
  }
};
