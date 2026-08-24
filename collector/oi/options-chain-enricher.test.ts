import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildAllExpirySnapshots, enrichSnapshotsWithOptionsOi } from './options-chain-enricher.js';
import { normalizeSnapshot } from './oi-wall-engine.js';

test('enriches missing tenor OI from canonical options-chain rows', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gold-sight-options-'));
  try {
    await writeFile(path.join(root, 'GC_options_20260807.csv'), [
      'trade_date,fetched_at,symbol,expiry_code,expiry_date,days_to_expiry,strike,option_type,volume,open_interest,oi_as_of_date',
      '2026-08-07,2026-08-07T19:00:00.000Z,GC,Q6,2026-08-14,7,4300,C,10,12000,2026-08-06',
      '2026-08-07,2026-08-07T19:00:00.000Z,GC,Q6,2026-08-14,7,4300,P,20,9000,2026-08-06',
    ].join('\n'));
    const source = normalizeSnapshot({
      symbol: 'GC', tradeDate: '2026-08-07', sessionSlot: 'close', targetDte: 7,
      actualDte: 7, expiryDate: '2026-08-14', futurePrice: 4300,
      strikes: [{ viewName: 'default', strike: 4300, callVolume: 10, putVolume: 20 }],
    }, null);
    const [enriched] = await enrichSnapshotsWithOptionsOi([source], root);
    assert.equal(enriched.strikes[0].callOpenInterest, 12000);
    assert.equal(enriched.strikes[0].putOpenInterest, 9000);
    assert.equal(enriched.oiSource, 'options_chain_eod');
    assert.equal(enriched.oiAsOfDate, '2026-08-06');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('builds an all-expiry layer, including far-dated contracts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gold-sight-all-expiry-'));
  try {
    await writeFile(path.join(root, 'GC_options_20260807.csv'), [
      'trade_date,fetched_at,symbol,expiry_code,expiry_date,days_to_expiry,strike,option_type,volume,open_interest,oi_as_of_date,is_valid',
      '2026-08-07,2026-08-07T19:00:00.000Z,GC,Q6,2026-08-14,7,4300,C,10,12000,2026-08-06,true',
      '2026-08-07,2026-08-07T19:00:00.000Z,GC,Q6,2026-08-14,7,4300,P,20,9000,2026-08-06,true',
      '2026-08-07,2026-08-07T19:00:00.000Z,GC,F7,2027-01-26,172,4500,C,1,5000,2026-08-06,true',
      '2026-08-07,2026-08-07T19:00:00.000Z,GC,F7,2027-01-26,172,4500,P,2,7000,2026-08-06,true',
    ].join('\n'));
    const anchor = normalizeSnapshot({
      symbol: 'GC', tradeDate: '2026-08-07', sessionSlot: 'close', targetDte: 7,
      actualDte: 7, expiryDate: '2026-08-14', futurePrice: 4300,
      strikes: [],
    }, null);
    const snapshots = await buildAllExpirySnapshots([anchor], root);
    assert.equal(snapshots.length, 2);
    const far = snapshots.find((snapshot) => snapshot.expiryDate === '2027-01-26');
    assert.ok(far);
    assert.equal(far.targetDte, 172);
    assert.equal(far.strikes[0].callOpenInterest, 5000);
    assert.equal(far.strikes[0].putOpenInterest, 7000);
    assert.equal(far.oiSource, 'options_chain_eod');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
