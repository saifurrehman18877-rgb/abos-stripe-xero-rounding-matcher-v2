const assert = require('assert');
const {
  toMinorUnits,
  normalizeDate,
  daysBetween,
  matchTransactions,
  generateAdjustments,
  summarizeReconciliation,
} = require('./logic.js');

// toMinorUnits
assert.strictEqual(toMinorUnits(19.99), 1999);
assert.strictEqual(toMinorUnits('19.99'), 1999);
assert.strictEqual(toMinorUnits(19.999999999998), 2000);
assert.strictEqual(toMinorUnits('abc'), 0);
assert.strictEqual(toMinorUnits(undefined), 0);
assert.strictEqual(toMinorUnits(0), 0);
assert.strictEqual(toMinorUnits(-5.5), -550);

// normalizeDate
assert.strictEqual(normalizeDate('2024-03-05'), '2024-03-05');
assert.strictEqual(normalizeDate(new Date(Date.UTC(2024, 2, 5))), '2024-03-05');
assert.strictEqual(normalizeDate(''), '');
assert.strictEqual(normalizeDate('not-a-date but has 2024-06-15 in it'), '2024-06-15');

// daysBetween
assert.strictEqual(daysBetween('2024-01-01', '2024-01-04'), 3);
assert.strictEqual(daysBetween('2024-01-04', '2024-01-01'), 3);
assert.strictEqual(daysBetween('2024-01-01', '2024-01-01'), 0);
assert.strictEqual(daysBetween('bogus', '2024-01-01'), Infinity);

// matchTransactions - exact match
{
  const stripe = [{ id: 's1', date: '2024-01-01', description: 'Payout', amount: 100.00, amountMinor: 10000, currency: 'USD' }];
  const xero = [{ id: 'x1', date: '2024-01-01', description: 'Stripe payout', amount: 100.00, amountMinor: 10000, currency: 'USD' }];
  const result = matchTransactions(stripe, xero);
  assert.strictEqual(result.matched.length, 1);
  assert.strictEqual(result.matched[0].type, 'exact');
  assert.strictEqual(result.matched[0].diffCents, 0);
  assert.strictEqual(result.unmatchedStripe.length, 0);
  assert.strictEqual(result.unmatchedXero.length, 0);
}

// matchTransactions - rounding match within default tolerance (<=5 cents)
{
  const stripe = [{ id: 's2', date: '2024-01-02', description: 'Payout', amount: 50.00, amountMinor: 5000, currency: 'USD' }];
  const xero = [{ id: 'x2', date: '2024-01-03', description: 'Stripe payout', amount: 50.03, amountMinor: 5003, currency: 'USD' }];
  const result = matchTransactions(stripe, xero);
  assert.strictEqual(result.matched.length, 1);
  assert.strictEqual(result.matched[0].type, 'rounding');
  assert.strictEqual(result.matched[0].diffCents, 3);
}

// matchTransactions - discrepancy too large, no match
{
  const stripe = [{ id: 's3', date: '2024-01-05', description: 'Payout', amount: 20.00, amountMinor: 2000, currency: 'USD' }];
  const xero = [{ id: 'x3', date: '2024-01-05', description: 'Stripe payout', amount: 20.50, amountMinor: 2050, currency: 'USD' }];
  const result = matchTransactions(stripe, xero);
  assert.strictEqual(result.matched.length, 0);
  assert.strictEqual(result.unmatchedStripe.length, 1);
  assert.strictEqual(result.unmatchedXero.length, 1);
}

// matchTransactions - date outside tolerance, no match
{
  const stripe = [{ id: 's4', date: '2024-01-01', description: 'Payout', amount: 10.00, amountMinor: 1000, currency: 'USD' }];
  const xero = [{ id: 'x4', date: '2024-01-10', description: 'Stripe payout', amount: 10.00, amountMinor: 1000, currency: 'USD' }];
  const result = matchTransactions(stripe, xero, { dateToleranceDays: 3 });
  assert.strictEqual(result.matched.length, 0);
  assert.strictEqual(result.unmatchedStripe.length, 1);
  assert.strictEqual(result.unmatchedXero.length, 1);
}

// matchTransactions - currency mismatch prevents match
{
  const stripe = [{ id: 's5', date: '2024-01-01', description: 'Payout', amount: 10.00, amountMinor: 1000, currency: 'USD' }];
  const xero = [{ id: 'x5', date: '2024-01-01', description: 'Stripe payout', amount: 10.00, amountMinor: 1000, currency: 'EUR' }];
  const result = matchTransactions(stripe, xero);
  assert.strictEqual(result.matched.length, 0);
}

// matchTransactions - prefers exact match over rounding when both candidates available
{
  const stripe = [{ id: 's6', date: '2024-01-01', description: 'Payout', amount: 100.00, amountMinor: 10000, currency: 'USD' }];
  const xero = [
    { id: 'x-round', date: '2024-01-01', description: 'a', amount: 100.02, amountMinor: 10002, currency: 'USD' },
    { id: 'x-exact', date: '2024-01-01', description: 'b', amount: 100.00, amountMinor: 10000, currency: 'USD' },
  ];
  const result = matchTransactions(stripe, xero);
  assert.strictEqual(result.matched.length, 1);
  assert.strictEqual(result.matched[0].xero.id, 'x-exact');
  assert.strictEqual(result.matched[0].type, 'exact');
}

// generateAdjustments - only rounding matches produce adjustments
{
  const matchedPairs = [
    {
      stripe: { id: 's1', date: '2024-01-01', description: 'Payout', amountMinor: 10000, currency: 'USD' },
      xero: { id: 'x1', date: '2024-01-01', description: 'Stripe payout', amountMinor: 10000, currency: 'USD' },
      diffCents: 0,
      type: 'exact',
    },
    {
      stripe: { id: 's2', date: '2024-01-02', description: 'Payout2', amountMinor: 5000, currency: 'USD' },
      xero: { id: 'x2', date: '2024-01-03', description: 'Stripe payout2', amountMinor: 5003, currency: 'USD' },
      diffCents: 3,
      type: 'rounding',
    },
  ];
  const adjustments = generateAdjustments(matchedPairs);
  assert.strictEqual(adjustments.length, 1);
  assert.strictEqual(adjustments[0].stripeId, 's2');
  assert.strictEqual(adjustments[0].xeroId, 'x2');
  assert.strictEqual(adjustments[0].adjustmentAmountMinor, 3);
  assert.strictEqual(adjustments[0].adjustmentAmount, 0.03);
  assert.strictEqual(adjustments[0].currency, 'USD');
  assert.strictEqual(adjustments[0].accountName, 'Bank Fees / FX Rounding');
}

// generateAdjustments - negative adjustment when xero amount is lower
{
  const matchedPairs = [
    {
      stripe: { id: 's3', date: '2024-01-04', description: 'Payout3', amountMinor: 5000, currency: 'USD' },
      xero: { id: 'x3', date: '2024-01-04', description: 'Stripe payout3', amountMinor: 4997, currency: 'USD' },
      diffCents: 3,
      type: 'rounding',
    },
  ];
  const adjustments = generateAdjustments(matchedPairs);
  assert.strictEqual(adjustments[0].adjustmentAmountMinor, -3);
  assert.strictEqual(adjustments[0].adjustmentAmount, -0.03);
}

// generateAdjustments - non-array input returns empty array
assert.deepStrictEqual(generateAdjustments(null), []);
assert.deepStrictEqual(generateAdjustments(undefined), []);

// summarizeReconciliation
{
  const matchResult = {
    matched: [
      { type: 'exact' },
      { type: 'rounding' },
      { type: 'rounding' },
    ],
    unmatchedStripe: [{}],
    unmatchedXero: [{}, {}],
  };
  const adjustments = [
    { adjustmentAmountMinor: 3 },
    { adjustmentAmountMinor: -5 },
  ];
  const summary = summarizeReconciliation(matchResult, adjustments);
  assert.strictEqual(summary.totalStripeTransactions, 4);
  assert.strictEqual(summary.totalXeroTransactions, 5);
  assert.strictEqual(summary.exactMatches, 1);
  assert.strictEqual(summary.roundingMatches, 2);
  assert.strictEqual(summary.unmatchedStripeCount, 1);
  assert.strictEqual(summary.unmatchedXeroCount, 2);
  assert.strictEqual(summary.totalAdjustmentAmountMinor, -2);
  assert.strictEqual(summary.totalAdjustmentAmount, -0.02);
}

// summarizeReconciliation - empty/missing inputs handled gracefully
{
  const summary = summarizeReconciliation({}, []);
  assert.strictEqual(summary.totalStripeTransactions, 0);
  assert.strictEqual(summary.totalXeroTransactions, 0);
  assert.strictEqual(summary.exactMatches, 0);
  assert.strictEqual(summary.roundingMatches, 0);
  assert.strictEqual(summary.totalAdjustmentAmountMinor, 0);
  assert.strictEqual(summary.totalAdjustmentAmount, 0);
}

console.log('All tests passed.');