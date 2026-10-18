const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

Object.assign(process.env, {
    SELL_PERCENT: '3', TRADE_DIFFERENCE_1000: '5', MIN_SEL_AMOUNT_ETH: '1000000000000000',
    MIN_SEL_AMOUNT_STRK: '5000000000000000000', MIN_GAS_FEES: '1000000000000000000', TIP: '0'
});
const { loadRows, seedHistory, effectiveCounter, replay, args, comparisonCases } = require('../scripts/replayQuotes.cjs');
const wad = n => (BigInt(n) * 10n ** 18n).toString();
const t0 = Date.UTC(2026, 9, 17);
const seed = [{
    hash: 'open', timestamp: t0 - 24 * 3600000, sell: 'eth', status: 'SUCCEEDED',
    sellAmount: wad(1), buyAmount: wad(1000), balanceEth: wad(10), balanceStrk: wad(2000)
}];
const options = { gas: .23, slippage: .003, fillLoss: 0, cooldown: 20, failedFees: '0', decayHours: 6 };

test('counter decay relaxes slowly, clamps at zero and re-arms after an opening', () => {
    const hour = 3600000;
    assert.equal(effectiveCounter(8, 5 * hour, 0, 6), 8);
    assert.equal(effectiveCounter(8, 6 * hour, 0, 6), 7);
    assert.equal(effectiveCounter(8, 60 * hour, 0, 6), 0);
    assert.equal(effectiveCounter(8, 60 * hour, 60 * hour, 6), 8);
    assert.equal(effectiveCounter(8, 60 * hour, 0, 0), 8);
});

test('CSV reader combines months, preserves absent directions and rejects invalid rows', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quote-replay-'));
    try {
        fs.writeFileSync(path.join(dir, 'quotes-2026-10.csv'), 'ts,strkToEth,ethToStrk\n2,,123\n3,unfinished');
        fs.writeFileSync(path.join(dir, 'quotes-2026-09.csv'), 'ts,strkToEth,ethToStrk\n1,124,\n');
        const data = loadRows(dir);
        assert.equal(data.incompleteLines, 1);
        assert.deepEqual(data.rows, [{ ts: 1, strk: 124n, eth: null }, { ts: 2, strk: null, eth: 123n }]);
        fs.appendFileSync(path.join(dir, 'quotes-2026-09.csv'), '4,NaN,5\n');
        assert.throws(() => loadRows(dir), /Invalid quote/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('seed reopens positions closed after start without importing future wallet balances', () => {
    const trades = structuredClone(seed);
    trades[0].matchedBy = 'close';
    trades.push({ ...seed[0], hash: 'close', timestamp: t0 + 1000, sell: 'strk', matchedBy: 'open' });
    const hist = seedHistory(trades, t0);
    assert.equal(hist.length, 1);
    assert.equal(hist[0].matchedBy, undefined);
    assert.equal(trades[0].matchedBy, 'close');
    assert.throws(() => seedHistory(trades, t0 - 48 * 3600000), /preceding confirmed/);
});

test('offline production checks preserve flat behaviour and missing quotes never fill', async () => {
    const rows = [
        { ts: t0, strk: 100000000n, eth: 100000000n },
        { ts: t0 + 3600000, strk: 100000000n, eth: null }
    ];
    const result = await replay(seed, rows, options);
    assert.equal(result.events.length, 0);
    assert.equal(result.excessETH, 0);
    const missing = await replay(seed, [
        { ts: t0, strk: 120000000n, eth: null },
        { ts: t0 + 3600000, strk: 120000000n, eth: null }
    ], options);
    assert.equal(missing.events.length, 0);
});

test('replay matches a new position once, stays causal and never changes the seed', async () => {
    const original = JSON.stringify(seed);
    const rows = [
        { ts: t0, strk: 110200000n, eth: 110000000n },
        { ts: t0 + 60000, strk: 107000000n, eth: 106800000n },
        { ts: t0 + 120000, strk: 100000000n, eth: 100000000n }
    ];
    const full = await replay(seed, rows, options);
    const prefix = await replay(seed, rows.slice(0, 2), options);
    assert.equal(full.opens, 1);
    assert.equal(full.closes, 1);
    assert.equal(full.newPositionsLeft, 0);
    assert.deepEqual(prefix.events, full.events.filter(t => t.timestamp <= rows[1].ts));
    assert.equal(JSON.stringify(seed), original);
});

test('CLI rejects unknown flags and missing values', () => {
    assert.throws(() => args(['--secret', 'x']), /Unknown option/);
    assert.throws(() => args(['--out']), /missing value/);
});

test('extended suite covers independent settings and combinations without duplicate decay cases', () => {
    const cases = comparisonCases('extended', 6);
    assert.equal(cases.length, 15);
    assert.equal(cases.filter(c => c.name === 'decay 6h').length, 1);
    assert(cases.some(c => c.sellPercent === 10 && c.decayHours === 0));
    assert(cases.some(c => c.knifeStrength === 1 && c.buybackCap === 1 && c.sellPercent === 5));
    assert.deepEqual(comparisonCases('basic', 6), [
        { name: 'current', decayHours: 0 }, { name: 'decay 6h', decayHours: 6 }
    ]);
    assert.throws(() => comparisonCases('unknown', 6), /--suite/);
});

test('half knife addition changes the opening threshold without leaking between runs', async () => {
    const rows = [
        { ts: t0, strk: 101800000n, eth: 101700000n },
        { ts: t0 + 1000, strk: 101800000n, eth: 101700000n }
    ];
    const base = { ...options, decayHours: 0 };
    const current = await replay(seed, rows, base);
    const half = await replay(seed, rows, { ...base, knifeStrength: 1 });
    const again = await replay(seed, rows, base);
    assert.equal(current.opens, 0);
    assert.equal(half.opens, 1);
    assert.equal(half.events[0].gapPerMille, 10);
    assert.deepEqual(again, current);
});

test('base-only buyback closes inherited knife positions earlier', async () => {
    const trades = structuredClone(seed);
    trades[0].fallingKnifeCounter = 7;
    const rows = [
        { ts: t0, strk: 99000000n, eth: 98900000n },
        { ts: t0 + 1000, strk: 99000000n, eth: 98900000n }
    ];
    const current = await replay(trades, rows, options);
    const quicker = await replay(trades, rows, { ...options, buybackCap: 1 });
    assert.equal(current.closes, 0);
    assert.equal(quicker.closes, 1);
});

test('bigger openings use the requested balance percentage and closing size remains position-based', async () => {
    const rows = [
        { ts: t0, strk: 110200000n, eth: 110000000n },
        { ts: t0 + 60000, strk: 107000000n, eth: 106800000n }
    ];
    const larger = await replay(seed, rows, { ...options, sellPercent: 10 });
    const normal = await replay(seed, rows, options);
    assert.equal(larger.events[0].eth, 9);
    assert.equal(normal.events[0].eth, 9.7);
    assert.equal(larger.closes, 1);
    assert.equal(larger.newPositionsLeft, 0);
    assert(larger.events[1].eth > 10);
    assert.equal(larger.options.sellPercent, 10);
});
