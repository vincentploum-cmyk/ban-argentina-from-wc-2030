'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const store = require('./lib/store');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const CURRENCY = (process.env.CURRENCY || 'eur').toLowerCase();

// Stripe is optional at boot so the site still renders (in "demo mode")
// before keys are configured. Donations are only enabled once a secret key
// is present.
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const stripe = STRIPE_SECRET_KEY ? require('stripe')(STRIPE_SECRET_KEY) : null;

if (!stripe) {
  console.warn(
    '[warn] STRIPE_SECRET_KEY is not set — donations run in DEMO MODE ' +
      '(no real charges). Copy .env.example to .env and add your keys.'
  );
}

// ---------------------------------------------------------------------------
// Stripe webhook must be registered BEFORE express.json() so we get the raw
// body needed for signature verification.
// ---------------------------------------------------------------------------
app.post('/api/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    return res.status(503).json({ error: 'Webhooks not configured.' });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const meta = session.metadata || {};
    store.recordDonation({
      sessionId: session.id,
      firstName: meta.firstName,
      lastName: meta.lastName,
      amount: (session.amount_total || 0) / 100,
      currency: session.currency || CURRENCY,
      consentPublic: meta.consentPublic !== 'false',
    });
    console.log(`Recorded donation from session ${session.id}`);
  }

  res.json({ received: true });
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Config for the frontend (publishable key + flags).
// ---------------------------------------------------------------------------
app.get('/api/config', (req, res) => {
  res.json({
    donationsEnabled: Boolean(stripe),
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || null,
    currency: CURRENCY,
  });
});

// ---------------------------------------------------------------------------
// Create a Stripe Checkout session for a donation.
// ---------------------------------------------------------------------------
app.post('/api/create-checkout-session', async (req, res) => {
  if (!stripe) {
    return res.status(503).json({
      error: 'Donations are not configured yet. Add your Stripe keys to enable them.',
    });
  }

  try {
    const { amount, firstName, lastName, consentPublic } = req.body || {};
    const numericAmount = Number(amount);

    if (!Number.isFinite(numericAmount) || numericAmount < 1) {
      return res.status(400).json({ error: 'Please enter a donation of at least 1.' });
    }
    if (numericAmount > 100000) {
      return res.status(400).json({ error: 'Donation amount is too large.' });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: CURRENCY,
            product_data: {
              name: 'Donation — Ban Argentina from WC 2030 campaign',
              description: 'Supports petition filing and campaign costs.',
            },
            unit_amount: Math.round(numericAmount * 100),
          },
          quantity: 1,
        },
      ],
      metadata: {
        firstName: (firstName || '').toString().slice(0, 60),
        lastName: (lastName || '').toString().slice(0, 60),
        consentPublic: consentPublic === false ? 'false' : 'true',
      },
      success_url: `${PUBLIC_BASE_URL}/?donated=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${PUBLIC_BASE_URL}/?canceled=1`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('create-checkout-session error:', err.message);
    res.status(500).json({ error: 'Could not start checkout. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// Leaderboard + stats.
// ---------------------------------------------------------------------------
app.get('/api/donors/top', (req, res) => {
  res.json(store.getTopDonors(10));
});

app.get('/api/stats', (req, res) => {
  res.json({
    donations: store.getDonationStats(),
    signatures: store.getSignatureCount(),
  });
});

// ---------------------------------------------------------------------------
// Petition signing.
// ---------------------------------------------------------------------------
app.post('/api/petition/sign', (req, res) => {
  const { firstName, lastName, email, country } = req.body || {};
  if (!firstName || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'A first name and a valid email are required.' });
  }
  const result = store.addSignature({ firstName, lastName, email, country });
  res.json({ ok: true, alreadySigned: !result.added, count: result.count });
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Campaign site running at ${PUBLIC_BASE_URL} (port ${PORT})`);
});
