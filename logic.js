/**
 * Stripe-Xero Rounding Matcher v2
 * Core logic for matching Stripe payout transactions against Xero bank feed
 * transactions, accounting for tiny FX rounding discrepancies, and generating
 * the adjustment entries bookkeepers need to close the books.
 */

/**
 * Parse a currency amount into integer minor units (cents) to avoid
 * floating point comparison issues.
 * @param {number|string} amount
 * @returns {number} integer minor units
 */
function toMinorUnits(amount) {
  const num = typeof amount === 'string' ? parseFloat(amount) : amount;
  if (typeof num !== 'number' || Number.isNaN(num)) return 0;
  // Round to avoid floating point artifacts (e.g. 19.999999999998)
  return Math.round(num * 100);
}

/**
 * Normalize a date string/Date to YYYY-MM-DD for comparison.
 * @param {string|Date} date
 * @returns {string}
 */
function normalizeDate(date) {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) {
    // fallback: try to salvage a YYYY-MM-DD prefix
    const s = String(date);
    const m = s.match(/(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : s;
  }
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

/**
 * Days between two normalized YYYY-MM-DD date strings (absolute).
 * @param {string} d1
 * @param {string} d2
 * @returns {number}
 */
function daysBetween(d1, d2) {
  const t1 = new Date(d1 + 'T00:00:00Z').getTime();
  const t2 = new Date(d2 + 'T00:00:00Z').getTime();
  if (Number.isNaN(t1) || Number.isNaN(t2)) return Infinity;
  return Math.abs(t1 - t2) / (1000 * 60 * 60 * 24);
}

/**
 * Parse a CSV string of Stripe payout transactions into normalized records.
 * Expected columns (header row, case-insensitive, flexible naming):
 *   id / transaction_id, date, description / reference, amount, currency
 * @param {string} csvString
 * @returns {Array<{id: string, date: string, description: string, amount: number, amountMinor: number, currency: string}>}
 */
function parseStripeCsv(csvString) {
  return parseTransactionCsv(csvString, 'stripe');
}

/**
 * Parse a CSV string of Xero bank feed transactions into normalized records.
 * @param {string} csvString
 * @returns {Array<{id: string, date: string, description: string, amount: number, amountMinor: number, currency: string}>}
 */
function parseXeroCsv(csvString) {
  return parseTransactionCsv(csvString, 'xero');
}

/**
 * Shared CSV parsing logic. Uses PapaParse (browser: window.Papa, node: require).
 * @param {string} csvString
 * @param {string} source - 'stripe' | 'xero' (used only for id prefixing fallback)
 * @returns {Array<Object>}
 */
function parseTransactionCsv(csvString, source) {
  if (!csvString || typeof csvString !== 'string') return [];

  const Papa = typeof require !== 'undefined' ? require('papaparse') : window.Papa;
  const parsed = Papa.parse(csvString.trim(), { header: true, skipEmptyLines: true });
  const rows = parsed.data || [];

  const findKey = (row, candidates) => {
    const keys = Object.keys(row);
    for (const cand of candidates) {
      const found = keys.find(k => k.trim().toLowerCase() === cand);
      if (found) return found;
    }
    return null;
  };

  const records = [];
  rows.forEach((row, idx) => {
    if (!row || Object.keys(row).length === 0) return;

    const idKey = findKey(row, ['id', 'transaction_id', 'transactionid', 'txn_id']);
    const dateKey = findKey(row, ['date', 'transaction_date', 'created', 'created (utc)']);
    const descKey = findKey(row, ['description', 'reference', 'memo', 'particulars']);
    const amountKey = findKey(row, ['amount', 'amount (usd)', 'net', 'total']);
    const currencyKey = findKey(row, ['currency', 'currency_code', 'ccy']);

    const rawAmount = amountKey ? row[amountKey] : undefined;
    const amount = typeof rawAmount === 'string'
      ? parseFloat(rawAmount.replace(/[,$]/g, ''))
      : rawAmount;

    if (amount === undefined || Number.isNaN(amount)) return;

    const date = normalizeDate(dateKey ? row[dateKey] : '');

    records.push({
      id: (idKey && row[idKey]) ? String(row[idKey]) : `${source}-${idx}`,
      date,
      description: descKey ? String(row[descKey] || '') : '',
      amount: Math.round(amount * 100) / 100,
      amountMinor: toMinorUnits(amount),
      currency: currencyKey && row[currencyKey] ? String(row[currencyKey]).trim().toUpperCase() : 'USD',
    });
  });

  return records;
}

/**
 * Match Stripe transactions to Xero transactions, identifying:
 *  - exact matches (same amount, within date tolerance)
 *  - rounding-discrepancy matches (amount differs by <= maxDiscrepancyCents, within date tolerance)
 *  - unmatched Stripe transactions
 *  - unmatched Xero transactions
 *
 * Matching strategy: for each Stripe transaction, find the closest-in-date
 * candidate Xero transaction (not yet consumed) whose amount is within
 * maxDiscrepancyCents. Prefer exact amount matches over discrepancy matches;
 * among candidates of equal amount-match quality, prefer the smallest date
 * difference within dateToleranceDays.
 *
 * @param {Array} stripeTxns - normalized Stripe transactions (see parseStripeCsv)
 * @param {Array} xeroTxns - normalized Xero transactions (see parseXeroCsv)
 * @param {Object} [options]
 * @param {number} [options.maxDiscrepancyCents=5] - max allowed |diff| in cents to still count as a rounding match
 * @param {number} [options.dateToleranceDays=3] - max allowed date difference for a candidate match
 * @returns {{
 *   matched: Array<{stripe: Object, xero: Object, diffCents: number, type: 'exact'|'rounding'}>,
 *   unmatchedStripe: Array<Object>,
 *   unmatchedXero: Array<Object>
 * }}
 */
function matchTransactions(stripeTxns, xeroTxns, options = {}) {
  const maxDiscrepancyCents = options.maxDiscrepancyCents != null ? options.maxDiscrepancyCents : 5;
  const dateToleranceDays = options.dateToleranceDays != null ? options.dateToleranceDays : 3;

  const stripeList = Array.isArray(stripeTxns) ? stripeTxns.slice() : [];
  const xeroPool = Array.isArray(xeroTxns) ? xeroTxns.map(t => ({ txn: t, used: false })) : [];

  const matched = [];
  const unmatchedStripe = [];

  for (const s of stripeList) {
    let best = null; // { entry, diffCents, dateDiff }

    for (const entry of xeroPool) {
      if (entry.used) continue;
      const x = entry.txn;
      if (x.currency && s.currency && x.currency !== s.currency) continue;

      const dateDiff = daysBetween(s.date, x.date);
      if (dateDiff > dateToleranceDays) continue;

      const diffCents = Math.abs(s.amountMinor - x.amountMinor);
      if (diffCents > maxDiscrepancyCents) continue;

      if (
        !best ||
        diffCents < best.diffCents ||
        (diffCents === best.diffCents && dateDiff < best.dateDiff)
      ) {
        best = { entry, diffCents, dateDiff };
      }
    }

    if (best) {
      best.entry.used = true;
      matched.push({
        stripe: s,
        xero: best.entry.txn,
        diffCents: best.diffCents,
        type: best.diffCents === 0 ? 'exact' : 'rounding',
      });
    } else {
      unmatchedStripe.push(s);
    }
  }

  const unmatchedXero = xeroPool.filter(e => !e.used).map(e => e.txn);

  return { matched, unmatchedStripe, unmatchedXero };
}

/**
 * Given the matched pairs from matchTransactions, generate the bank-fee /
 * FX rounding adjustment entries a bookkeeper needs to post in Xero so the
 * accounts reconcile. Only rounding-type matches (non-zero diff) produce
 * an adjustment; exact matches produce none.
 *
 * The adjustment amount is signed from Xero's perspective: if Xero's bank
 * feed amount is lower than Stripe's reported amount, the adjustment is a
 * negative (expense/fee) entry to bring Xero's ledger down to match Stripe's
 * recorded revenue was already booked; conventionally we compute:
 *   adjustment = xero.amount - stripe.amount
 * i.e. the value that must be added to the Stripe-recorded amount to equal
 * what actually hit the bank, expressed in major currency units.
 *
 * @param {Array<{stripe: Object, xero: Object, diffCents: number, type: string}>} matchedPairs
 * @returns {Array<{
 *   date: string,
 *   description: string,
 *   stripeId: string,
 *   xeroId: string,
 *   currency: string,
 *   adjustmentAmount: number,
 *   adjustmentAmountMinor: number,
 *   accountName: string
 * }>}
 */
function generateAdjustments(matchedPairs) {
  if (!Array.isArray(matchedPairs)) return [];

  const adjustments = [];
  for (const pair of matchedPairs) {
    if (!pair || pair.type !== 'rounding') continue;
    const { stripe, xero } = pair;

    const adjustmentAmountMinor = xero.amountMinor - stripe.amountMinor;
    if (adjustmentAmountMinor === 0) continue;

    adjustments.push({
      date: xero.date || stripe.date,
      description: `FX rounding adjustment: ${stripe.description || stripe.id} vs ${xero.description || xero.id}`,
      stripeId: stripe.id,
      xeroId: xero.id,
      currency: xero.currency || stripe.currency,
      adjustmentAmount: Math.round(adjustmentAmountMinor) / 100,
      adjustmentAmountMinor,
      accountName: 'Bank Fees / FX Rounding',
    });
  }

  return adjustments;
}

/**
 * Summarize a reconciliation run: totals and counts useful for a UI dashboard.
 * @param {{matched: Array, unmatchedStripe: Array, unmatchedXero: Array}} matchResult
 * @param {Array} adjustments - output of generateAdjustments
 * @returns {{
 *   totalStripeTransactions: number,
 *   totalXeroTransactions: number,
 *   exactMatches: number,
 *   roundingMatches: number,
 *   unmatchedStripeCount: number,
 *   unmatchedXeroCount: number,
 *   totalAdjustmentAmountMinor: number,
 *   totalAdjustmentAmount: number
 * }}
 */
function summarizeReconciliation(matchResult, adjustments) {
  const matched = (matchResult && matchResult.matched) || [];
  const unmatchedStripe = (matchResult && matchResult.unmatchedStripe) || [];
  const unmatchedXero = (matchResult && matchResult.unmatchedXero) || [];
  const adj = Array.isArray(adjustments) ? adjustments : [];

  const exactMatches = matched.filter(m => m.type === 'exact').length;
  const roundingMatches = matched.filter(m => m.type === 'rounding').length;

  const totalAdjustmentAmountMinor = adj.reduce((sum, a) => sum + (a.adjustmentAmountMinor || 0), 0);

  return {
    totalStripeTransactions: matched.length + unmatchedStripe.length,
    totalXeroTransactions: matched.length + unmatchedXero.length,
    exactMatches,
    roundingMatches,
    unmatchedStripeCount: unmatchedStripe.length,
    unmatchedXeroCount: unmatchedXero.length,
    totalAdjustmentAmountMinor,
    totalAdjustmentAmount: Math.round(totalAdjustmentAmountMinor) / 100,
  };
}

if (typeof module !== 'undefined') {
  module.exports = {
    toMinorUnits,
    normalizeDate,
    daysBetween,
    parseStripeCsv,
    parseXeroCsv,
    parseTransactionCsv,
    matchTransactions,
    generateAdjustments,
    summarizeReconciliation,
  };
}