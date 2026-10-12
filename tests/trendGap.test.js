const assert = require('node:assert/strict');
const { test } = require('node:test');
const { BigNumber } = require('@ethersproject/bignumber');

Object.assign(process.env, { SELL_PERCENT: '3', TRADE_DIFFERENCE_1000: '5', MIN_SEL_AMOUNT_STRK: '1', MIN_SEL_AMOUNT_ETH: '1' });
const { toRatioPoints, removeSpikes, getHourlyVol, getTrendGap, applyTrendGap, pruneRatioPoints, mergeRatioPoints } = require('../dist/trendGap');

const DAY = 86_400_000;
const NOW = 100 * DAY;
const OPTIONS = { days: 14, move: 0.1, volK: 4, volDays: 30, baseDifference: 0.005 };
const point = (i, ratio, sell = 'eth', timestamp = NOW - (40 - i) * DAY) => ({ hash: `h${sell}${i}`, timestamp, sell, ratio });

test('toRatioPoints uses strk per eth for both directions and skips unusable entries', () => {
    const eth = (n) => BigNumber.from(10).pow(18).mul(n).toString();
    const points = toRatioPoints([
        { hash: 'initial', sell: 'eth', sellAmount: eth(1), buyAmount: eth(2), timestamp: 1 },
        { hash: 'b', sell: 'strk', sellAmount: eth(30000), buyAmount: eth(1), timestamp: 3 },
        { hash: 'a', sell: 'eth', sellAmount: eth(1), buyAmount: eth(25000), timestamp: 2 },
        { hash: 'pending', sell: 'eth', timestamp: 4 },
        { hash: 'bad', sell: 'eth', sellAmount: eth(1), buyAmount: '-5', timestamp: 5 }
    ]);
    assert.deepEqual(points.map((p) => [p.hash, p.ratio]), [['a', 25000 * 100000], ['b', 30000 * 100000]]);
});

test('removeSpikes drops isolated glitches but keeps real jumps', () => {
    const glitch = [100, 101, 100, 300, 101, 100].map((r, i) => point(i, r));
    assert.deepEqual(removeSpikes(glitch).map((p) => p.ratio), [100, 101, 100, 101, 100]);
    const jump = [100, 101, 100, 150, 151, 150].map((r, i) => point(i, r));
    assert.equal(removeSpikes(jump).length, 6);
});

test('hourly vol ignores the fee bounce between eth and strk sells', () => {
    // eth sells at 100, strk sells at 101 at the same market price: no movement within each direction
    const points = [];
    for (let i = 0; i < 20; i++) points.push(point(i, 100, 'eth', NOW - (20 - i) * DAY), point(i, 101, 'strk', NOW - (20 - i) * DAY + 1));
    assert.equal(getHourlyVol(points, NOW, 30), 0);
});

test('getTrendGap uses the median of trades at least `days` old and vol scaled multiplier', () => {
    const points = [];
    for (let i = 0; i < 31; i++) points.push(point(i, 1000 * Math.exp(0.01 * i), 'eth', NOW - (30 - i) * DAY));
    const gap = getTrendGap(points, NOW, OPTIONS);
    assert.ok(Math.abs(gap.refRatio - 1000 * Math.exp(0.01 * 14)) < 1e-6);
    const expectedVol = Math.sqrt(30 * 0.0001 / (30 * 24));
    assert.ok(Math.abs(gap.hourlyVol - expectedVol) < 1e-12);
    assert.ok(Math.abs(gap.mult - Math.max(1, 4 * expectedVol / 0.005)) < 1e-9);
    assert.equal(getTrendGap(points, NOW, { ...OPTIONS, maxMult: 1.2 }).mult, 1.2);
    assert.equal(getTrendGap(points, NOW, { ...OPTIONS, maxMult: 0 }).mult, gap.mult);
    assert.equal(getTrendGap(points.slice(-10), NOW, OPTIONS), undefined);
    assert.equal(getTrendGap(points, NOW, { ...OPTIONS, days: 0 }), undefined);
});

test('applyTrendGap widens only the direction buying the coin that fell', () => {
    const gap = { refRatio: 1000, mult: 6, hourlyVol: 0.0075 };
    const base = BigNumber.from(15);
    // ratio up 20% (strk fell): selling eth buys strk -> wide; selling strk stays
    assert.equal(applyTrendGap('eth', base, gap, BigNumber.from(1200), 0.1).difference.toString(), '90');
    assert.equal(applyTrendGap('strk', base, gap, BigNumber.from(1200), 0.1).difference.toString(), '15');
    // ratio down 20% (eth fell): selling strk is the wide side
    assert.equal(applyTrendGap('strk', base, gap, BigNumber.from(800), 0.1).difference.toString(), '90');
    assert.equal(applyTrendGap('eth', base, gap, BigNumber.from(800), 0.1).difference.toString(), '15');
    // within the move threshold nothing changes
    assert.equal(applyTrendGap('eth', base, gap, BigNumber.from(1050), 0.1).difference.toString(), '15');
    assert.equal(applyTrendGap('eth', base, undefined, BigNumber.from(1200), 0.1).difference.toString(), '15');
});

test('pruneRatioPoints keeps the window plus the newest older reference trades', () => {
    const points = mergeRatioPoints(Array.from({ length: 60 }, (_, i) => point(i, 100, 'eth', NOW - (59 - i) * DAY)));
    const pruned = pruneRatioPoints(points, NOW, 37);
    assert.equal(pruned.length, 38 + 5);
    assert.equal(pruned[0].timestamp, NOW - 42 * DAY);
});
