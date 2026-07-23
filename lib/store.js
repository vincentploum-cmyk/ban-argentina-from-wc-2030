'use strict';

/**
 * Tiny append-only JSON file store.
 *
 * This is intentionally simple so the project runs with zero external
 * infrastructure. For anything beyond a demo / low traffic, swap this for a
 * real database (Postgres, SQLite, etc.) — the public API below is small
 * enough that only this file needs to change.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DONORS_FILE = path.join(DATA_DIR, 'donors.json');
const SIGNATURES_FILE = path.join(DATA_DIR, 'signatures.json');

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DONORS_FILE)) fs.writeFileSync(DONORS_FILE, '[]');
  if (!fs.existsSync(SIGNATURES_FILE)) fs.writeFileSync(SIGNATURES_FILE, '[]');
}

function readJson(file) {
  ensure();
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8') || '[]');
  } catch (err) {
    console.error(`Could not parse ${file}:`, err.message);
    return [];
  }
}

function writeJson(file, data) {
  ensure();
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

/** Anonymise a full name to "First L." for public display. */
function publicName(firstName, lastName) {
  const first = (firstName || '').trim() || 'Anonymous';
  const last = (lastName || '').trim();
  return last ? `${first} ${last[0].toUpperCase()}.` : first;
}

/** Record a confirmed donation. Amount is in the currency's major unit. */
function recordDonation({ firstName, lastName, amount, currency, consentPublic, sessionId }) {
  const donors = readJson(DONORS_FILE);
  // Idempotency: never double-count the same Stripe session.
  if (sessionId && donors.some((d) => d.sessionId === sessionId)) return;
  donors.push({
    sessionId: sessionId || null,
    firstName: (firstName || '').trim(),
    lastName: (lastName || '').trim(),
    amount: Number(amount) || 0,
    currency: currency || 'eur',
    consentPublic: consentPublic !== false,
    createdAt: new Date().toISOString(),
  });
  writeJson(DONORS_FILE, donors);
}

/** Sum donations grouped by a display key, most generous first. */
function aggregateTopDonors(donors, limit) {
  const byKey = new Map();
  for (const d of donors) {
    if (!d.consentPublic) continue;
    const display = publicName(d.firstName, d.lastName);
    const key = display.toLowerCase();
    const existing = byKey.get(key) || { name: display, total: 0, currency: d.currency };
    existing.total += d.amount;
    byKey.set(key, existing);
  }
  return [...byKey.values()]
    .sort((a, b) => b.total - a.total)
    .slice(0, limit || 10)
    .map((d) => ({ name: d.name, total: Math.round(d.total * 100) / 100, currency: d.currency }));
}

function isToday(iso) {
  const d = new Date(iso);
  const now = new Date();
  return (
    d.getUTCFullYear() === now.getUTCFullYear() &&
    d.getUTCMonth() === now.getUTCMonth() &&
    d.getUTCDate() === now.getUTCDate()
  );
}

/** Top donors for the current (UTC) day and all-time. */
function getTopDonors(limit = 10) {
  const donors = readJson(DONORS_FILE);
  return {
    today: aggregateTopDonors(donors.filter((d) => isToday(d.createdAt)), limit),
    allTime: aggregateTopDonors(donors, limit),
  };
}

/** Totals for the progress/hype counters. */
function getDonationStats() {
  const donors = readJson(DONORS_FILE);
  const total = donors.reduce((sum, d) => sum + (d.amount || 0), 0);
  return {
    totalRaised: Math.round(total * 100) / 100,
    donorCount: donors.length,
    currency: donors[0] ? donors[0].currency : 'eur',
  };
}

/** Add a petition signature (deduplicated by lowercased email). */
function addSignature({ firstName, lastName, email, country }) {
  const signatures = readJson(SIGNATURES_FILE);
  const normalizedEmail = (email || '').trim().toLowerCase();
  if (normalizedEmail && signatures.some((s) => s.email === normalizedEmail)) {
    return { added: false, count: signatures.length };
  }
  signatures.push({
    firstName: (firstName || '').trim(),
    lastName: (lastName || '').trim(),
    email: normalizedEmail,
    country: (country || '').trim(),
    createdAt: new Date().toISOString(),
  });
  writeJson(SIGNATURES_FILE, signatures);
  return { added: true, count: signatures.length };
}

function getSignatureCount() {
  return readJson(SIGNATURES_FILE).length;
}

module.exports = {
  recordDonation,
  getTopDonors,
  getDonationStats,
  addSignature,
  getSignatureCount,
  publicName,
};
