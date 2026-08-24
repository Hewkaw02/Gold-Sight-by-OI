import test from 'node:test';
import assert from 'node:assert/strict';
import { findMatchedExpiration, selectSettlementDate, type ExpiryInfo } from './cme-options-fetcher.js';

const septemberExpiry: ExpiryInfo = {
  code: 'U6',
  label: 'Sep 2026',
  groupLabel: 'American Options',
  date: '2026-08-26',
  contractMonth: 9,
  contractYear: 2026,
};

test('matches CME settlement metadata by contract month, not settlement last-trade date', () => {
  const metadata = [{
    label: 'American Options',
    expirations: [{
      label: 'Sep 2026',
      contractId: 'OGU26',
      expiration: { code: 'U6', month: 9, year: 2026 },
      // This is the latest available settlement trade date, not the option expiry.
      lastTradeDate: { timestamp: 1787288400000 },
    }],
  }];

  assert.equal(findMatchedExpiration(metadata, septemberExpiry)?.contractId, 'OGU26');
});

test('selects the latest settlement date not later than the requested trade date', () => {
  assert.equal(
    selectSettlementDate('2026-08-24', [{ formatedDate: '08/21/2026' }, { formatedDate: '08/20/2026' }]),
    '08/21/2026',
  );
  assert.equal(
    selectSettlementDate('2026-08-20', ['08/21/2026', '08/20/2026', '08/19/2026']),
    '08/20/2026',
  );
});
