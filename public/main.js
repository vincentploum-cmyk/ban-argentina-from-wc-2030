'use strict';

const CURRENCY_SYMBOLS = { eur: '€', usd: '$', gbp: '£', cad: 'C$', aud: 'A$' };
let config = { donationsEnabled: false, publishableKey: null, currency: 'eur' };
let currencySymbol = '€';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function $(sel, root = document) { return root.querySelector(sel); }
function $all(sel, root = document) { return [...root.querySelectorAll(sel)]; }

function formatMoney(amount) {
  const n = Number(amount) || 0;
  return currencySymbol + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

function formatNumber(n) {
  return Number(n || 0).toLocaleString();
}

let toastTimer;
function toast(message, kind = 'ok') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast toast-${kind === 'err' ? 'err' : 'ok'}`;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => { el.hidden = true; }, 300);
  }, 3800);
}

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  try {
    config = await api('/api/config');
  } catch (_) { /* keep defaults */ }
  currencySymbol = CURRENCY_SYMBOLS[config.currency] || '€';
  $('#currency-symbol').textContent = currencySymbol;
  $('#amount-symbol') && ($('#amount-symbol').textContent = currencySymbol);

  if (!config.donationsEnabled) {
    $('#demo-banner').hidden = false;
  }

  updateDonateButton();
  loadStats();
  loadDonors();
  mountVideos();
  handleReturnFromCheckout();
}

// ---------------------------------------------------------------------------
// Stats + counters
// ---------------------------------------------------------------------------
async function loadStats() {
  try {
    const { donations, signatures } = await api('/api/stats');
    $('#signature-count').textContent = formatNumber(signatures);
    $('#donor-count').textContent = formatNumber(donations.donorCount);
    $('#total-raised').textContent = formatMoney(donations.totalRaised);
  } catch (_) {
    $('#signature-count').textContent = '0';
    $('#donor-count').textContent = '0';
    $('#total-raised').textContent = formatMoney(0);
  }
}

async function loadDonors() {
  try {
    const { today, allTime } = await api('/api/donors/top');
    renderDonors('#donors-today', today, 'Be the first today →');
    renderDonors('#donors-alltime', allTime, 'No donors yet.');
  } catch (_) { /* ignore */ }
}

function renderDonors(sel, list, emptyText) {
  const ol = $(sel);
  if (!list || list.length === 0) {
    ol.innerHTML = `<li class="donor-empty">${emptyText}</li>`;
    return;
  }
  ol.innerHTML = list
    .map(
      (d) => `<li>
        <span class="donor-name">${escapeHtml(d.name)}</span>
        <span class="donor-amount">${formatMoney(d.total)}</span>
      </li>`
    )
    .join('');
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// ---------------------------------------------------------------------------
// Videos (click-to-load to avoid loading 4 iframes up front)
// ---------------------------------------------------------------------------
function mountVideos() {
  $all('.video-card').forEach((card) => {
    const id = card.dataset.yt;
    const embed = $('.video-embed', card);
    if (!id) return;
    embed.style.backgroundImage = `url(https://i.ytimg.com/vi/${id}/hqdefault.jpg)`;
    const play = document.createElement('span');
    play.className = 'play';
    embed.appendChild(play);
    embed.addEventListener('click', () => {
      embed.innerHTML =
        `<iframe src="https://www.youtube-nocookie.com/embed/${id}?autoplay=1" ` +
        `title="Campaign clip" allow="accelerometer; autoplay; clipboard-write; ` +
        `encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`;
    }, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Petition
// ---------------------------------------------------------------------------
$('#petition-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const msg = $('#petition-msg');
  const btn = $('button[type="submit"]', form);
  const body = {
    firstName: form.firstName.value.trim(),
    lastName: form.lastName.value.trim(),
    email: form.email.value.trim(),
    country: form.country.value.trim(),
  };
  btn.disabled = true;
  msg.textContent = '';
  try {
    const res = await api('/api/petition/sign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.alreadySigned) {
      msg.className = 'form-msg ok';
      msg.textContent = "You've already signed — thank you!";
    } else {
      msg.className = 'form-msg ok';
      msg.textContent = 'Signed! Your name is on the petition. 🖊️';
      form.reset();
      toast('Thanks for signing the petition!');
    }
    $('#signature-count').textContent = formatNumber(res.count);
  } catch (err) {
    msg.className = 'form-msg err';
    msg.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Donate
// ---------------------------------------------------------------------------
function selectedAmount() {
  return Number($('#amount').value) || 0;
}

function updateDonateButton() {
  const amt = selectedAmount();
  $('#donate-amount').textContent = formatMoney(amt);
}

$('#tier-row').addEventListener('click', (e) => {
  const tier = e.target.closest('.tier');
  if (!tier) return;
  $all('.tier').forEach((t) => t.classList.remove('tier-active'));
  tier.classList.add('tier-active');
  $('#amount').value = tier.dataset.amount;
  updateDonateButton();
});

$('#amount').addEventListener('input', () => {
  $all('.tier').forEach((t) =>
    t.classList.toggle('tier-active', Number(t.dataset.amount) === selectedAmount())
  );
  updateDonateButton();
});

$('#donate-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const msg = $('#donate-msg');
  const btn = $('#donate-btn');
  const amount = selectedAmount();

  if (!(amount >= 1)) {
    msg.className = 'form-msg err';
    msg.textContent = 'Please enter an amount of at least ' + formatMoney(1) + '.';
    return;
  }

  btn.disabled = true;
  msg.textContent = '';

  const payload = {
    amount,
    firstName: form.firstName.value.trim(),
    lastName: form.lastName.value.trim(),
    consentPublic: $('#consentPublic').checked,
  };

  if (!config.donationsEnabled) {
    msg.className = 'form-msg ok';
    msg.textContent =
      'Demo mode: this is where Stripe Checkout would open. Add Stripe keys to go live.';
    toast('Demo mode — no real charge was made.', 'ok');
    btn.disabled = false;
    return;
  }

  try {
    const { url } = await api('/api/create-checkout-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    window.location.assign(url);
  } catch (err) {
    msg.className = 'form-msg err';
    msg.textContent = err.message;
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Post-checkout return handling
// ---------------------------------------------------------------------------
function handleReturnFromCheckout() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('donated') === '1') {
    toast('Thank you for your donation! 🎉 You may appear on the board shortly.');
    cleanUrl();
    // Give the webhook a moment, then refresh the board.
    setTimeout(() => { loadStats(); loadDonors(); }, 2500);
  } else if (params.get('canceled') === '1') {
    toast('Checkout canceled — no charge was made.', 'err');
    cleanUrl();
  }
}

function cleanUrl() {
  window.history.replaceState({}, document.title, window.location.pathname + '#donate');
}

boot();
