const { test } = require('node:test');
const assert = require('node:assert/strict');

Object.assign(process.env, {
    SELL_PERCENT: '3', TRADE_DIFFERENCE_1000: '5',
    MIN_SEL_AMOUNT_ETH: '1', MIN_SEL_AMOUNT_STRK: '1'
});
const { effectiveCounter, getLastOpeningTimestamp, getFallingKnife, getMatchTradeDifference } = require('../dist/quote');
const hour = 3600000;
const opening = (hash, timestamp, sell = 'eth') => ({ hash, timestamp, sell, status: 'SUCCEEDED' });

test('live counter decays at exact four-hour boundaries in either direction', () => {
    for (const sell of ['eth', 'strk']) {
        const trades = [opening('a', hour, sell), opening('b', 2 * hour, sell), opening('c', 3 * hour, sell)];
        assert.deepEqual(getFallingKnife(trades, 7 * hour - 1), { sell, counter: 3 });
        assert.deepEqual(getFallingKnife(trades, 7 * hour), { sell, counter: 2 });
        assert.equal(getFallingKnife(trades, 11 * hour).counter, 1);
        assert.equal(getFallingKnife(trades, 15 * hour).counter, 0);
        assert.equal(getFallingKnife(trades, 100 * hour, 0).counter, 3);
        assert.equal(getFallingKnife(trades, 0).counter, 3);
        assert.equal(effectiveCounter(-2, 0, 0, 4), 0);
    }
});

test('new openings re-arm decay and restart reconstructs the same counter', () => {
    const trades = [opening('a', hour), opening('b', 2 * hour)];
    assert.equal(getFallingKnife(trades, 10 * hour).counter, 0);
    trades.push(opening('c', 10 * hour));
    assert.equal(getFallingKnife(trades, 10 * hour).counter, 3);
    assert.equal(getFallingKnife(trades, 14 * hour).counter, 2);
    const saved = JSON.stringify(trades);
    assert.deepEqual(getFallingKnife(JSON.parse(saved), 14 * hour), getFallingKnife(trades, 14 * hour));
    assert.equal(JSON.stringify(trades), saved);
});

test('closes keep their credits but do not reset the opening clock, including after restart', () => {
    const trades = [
        opening('a', hour), opening('b', 2 * hour), opening('c', 3 * hour),
        { ...opening('d', 4 * hour), matchedBy: 'close' },
        { ...opening('close', 7 * hour, 'strk'), matchedBy: 'd' }
    ];
    assert.equal(getLastOpeningTimestamp(trades, 8 * hour), 4 * hour);
    assert.equal(getFallingKnife(trades, 8 * hour, 0).counter, 2);
    assert.equal(getFallingKnife(JSON.parse(JSON.stringify(trades)), 8 * hour).counter, 1);
    assert.equal(getFallingKnife(trades, 12 * hour).counter, 0);
});

test('initial and archived closing records do not reset decay; missing opening timestamps prevent decay', () => {
    const trades = [
        { hash: 'initial', sell: 'eth', timestamp: 100 * hour },
        opening('a', hour),
        { ...opening('archived-close', 3 * hour, 'strk'), matchedBy: 'removed-opener' }
    ];
    assert.equal(getLastOpeningTimestamp(trades, 4 * hour), hour);
    trades.push({ hash: 'legacy', sell: 'eth' });
    assert.equal(getLastOpeningTimestamp(trades, 100 * hour), 100 * hour);
    assert.equal(getFallingKnife(trades, 100 * hour).counter, 1);
    assert.deepEqual(getFallingKnife([], 100 * hour), { counter: 0 });
});

test('BB 1 keeps base buyback targets for existing stored counters regardless of decay', () => {
    const trades = [
        { ...opening('a', hour), fallingKnifeCounter: 20 },
        opening('b', 2 * hour)
    ];
    assert.equal(getMatchTradeDifference(trades).toNumber(), 5);
    getFallingKnife(trades, 100 * hour);
    assert.equal(trades[0].fallingKnifeCounter, 20);
    assert.equal(getMatchTradeDifference(trades).toNumber(), 5);
});
