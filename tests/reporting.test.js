const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { toReportTransactions, buildWebTradeEntries, buildNextOpenTrade, computeMatchGroupTotals } = require('../dist/matching');

const reportEnv = {
    SELL_PERCENT: '1', TRADE_DIFFERENCE_1000: '10',
    MIN_SEL_AMOUNT_STRK: '1', MIN_SEL_AMOUNT_ETH: '1'
};

function trade(hash, timestamp, overrides = {}) {
    return {
        hash, timestamp, sell: 'eth', sellAmount: '1000000000000000000',
        buyAmount: '2000000000000000000', balanceEth: '10000000000000000000',
        balanceStrk: '20000000000000000000', ...overrides
    };
}

function matchedTrades() {
    return toReportTransactions([
        trade('first', 1000, { matchedBy: 'closer', fallingKnifeCounter: 2 }),
        trade('second', 2000, { matchedBy: 'closer', fallingKnifeCounter: 4 }),
        trade('closer', 3000, { sell: 'strk', matchedBy: 'first', fallingKnifeCounter: 9 })
    ]);
}

test('report conversion preserves applied counters and optional historical values', () => {
    const txs = toReportTransactions([trade('boosted', 1000, { fallingKnifeCounter: 3 }), trade('old', 2000)]);
    assert.equal(txs[0].fallingKnifeCounter, 3);
    assert.equal(txs[1].fallingKnifeCounter, undefined);
    assert.equal(buildWebTradeEntries(txs)[0].fallingKnifeCounter, 3);
});

test('matched groups report the highest opener counter, not the closing counter', () => {
    const txs = matchedTrades();
    assert.equal(computeMatchGroupTotals(txs).matchedFallingKnifeCounter, 4);
    const entries = buildWebTradeEntries(txs);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].hash, 'closer');
    assert.equal(entries[0].status, 'closed');
    assert.equal(entries[0].matchedFallingKnifeCounter, 4);
    assert.equal(entries[0].fallingKnifeCounter, undefined);
    assert.equal(entries[0].tradeCount, 2);
});

test('historical groups without boosted openers have no matched counter', () => {
    const txs = matchedTrades().map(t => ({ ...t, fallingKnifeCounter: 1 }));
    assert.equal(computeMatchGroupTotals(txs).matchedFallingKnifeCounter, undefined);
});

test('initial snapshots and dangling archived matches are not open trades or next goals', () => {
    const txs = toReportTransactions([
        trade('initial', 1000, { matchedBy: 'initial' }),
        trade('original', 2000, { matchedBy: 'archived-closer', fallingKnifeCounter: 3 }),
        trade('real-open', 3000, { fallingKnifeCounter: 2 })
    ]);
    assert.deepEqual(buildWebTradeEntries(txs).map(t => t.hash), ['real-open']);
    assert.equal(buildNextOpenTrade(txs, 'original'), null);
    assert.equal(buildNextOpenTrade(txs, 'initial'), null);
    assert.equal(buildNextOpenTrade(txs, undefined), null);
    assert.equal(buildNextOpenTrade(txs, 'real-open').fallingKnifeCounter, 2);
});

test('a closer without a reverse matchedBy link is still closed, never a next goal', () => {
    const txs = matchedTrades();
    delete txs[2].matchedBy;
    assert.equal(buildWebTradeEntries(txs)[0].status, 'closed');
    assert.equal(buildNextOpenTrade(txs, 'closer'), null);
});

function render(trades, nextOpen) {
    const rows = [];
    const source = fs.readFileSync(path.join(__dirname, '..', 'webapp', 'js', 'app.js'), 'utf8');
    const context = {
        document: {
            getElementById: () => ({ innerHTML: '', appendChild: row => rows.push(row) }),
            createElement: () => ({ innerHTML: '', classList: { add() {} } })
        },
        formatDate: String, formatShortDate: String, formatWei: String
    };
    vm.createContext(context);
    vm.runInContext(source.slice(source.indexOf('function renderTrades('), source.indexOf('let latestData')), context);
    context.renderTrades(trades, nextOpen);
    return rows;
}

test('100 closed entries append the genuine next open trade with its counter on a second status line', () => {
    const raw = [trade('real-open', 1000, { fallingKnifeCounter: 3 })];
    for (let i = 0; i < 100; i++) {
        raw.push(trade(`opener-${i}`, 2000 + i * 2, { matchedBy: `closer-${i}` }));
        raw.push(trade(`closer-${i}`, 2001 + i * 2, { sell: 'strk', matchedBy: `opener-${i}` }));
    }
    const txs = toReportTransactions(raw);
    const recent = buildWebTradeEntries(txs).slice(-100);
    assert.equal(recent.length, 100);
    assert.ok(recent.every(t => t.status === 'closed'));
    const rows = render(recent, buildNextOpenTrade(txs, 'real-open'));
    assert.equal(rows.length, 101);
    assert.match(rows[100].innerHTML, /<td><span class="status-open">Open · next goal<\/span><span class="status-detail">Falling knife: 3<\/span><\/td>/);
    assert.equal(render(recent, buildNextOpenTrade(txs, 'opener-0')).length, 100);
});

test('dashboard suppresses default counters and does not append invalid or duplicate next goals', () => {
    const open = { hash: 'open', status: 'open', timestamp: 1000, sell: 'eth', fallingKnifeCounter: 1 };
    assert.doesNotMatch(render([open], open)[0].innerHTML, /Falling knife/);
    assert.equal(render([open], { ...open, hash: 'other' }).length, 1);
    const closed = { ...open, status: 'closed', matchedFallingKnifeCounter: 4 };
    assert.equal(render([closed], closed).length, 1);
    assert.equal(render([closed], open).length, 1);
    assert.match(render([closed], null)[0].innerHTML, /Matched falling knife: 4/);
});

test('console reports show applied and matched counters, including archived summaries', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trader-report-test-'));
    const tradesPath = path.join(dir, 'trades.json');
    const aggregatePath = path.join(dir, 'aggregate.json');
    try {
        fs.writeFileSync(tradesPath, JSON.stringify([
            trade('first', 1000, { matchedBy: 'closer', fallingKnifeCounter: 4 }),
            trade('closer', 2000, { matchedBy: 'first', sell: 'strk' }),
            trade('open-eth', 3000, { fallingKnifeCounter: 2 }),
            trade('open-strk', 4000, { sell: 'strk', fallingKnifeCounter: 3 })
        ]));
        fs.writeFileSync(aggregatePath, JSON.stringify({ externalTransfers: [], matchedGroups: [{
            closingHash: 'archived', tradeCount: 2, fromTimestamp: 500, toTimestamp: 800,
            soldEth: '1', boughtEth: '2', txFeesEth: '0', failedFeesEth: '0',
            closingFeeKnown: true, matchedFallingKnifeCounter: 5
        }] }));
        const run = name => execFileSync(process.execPath, [path.join(__dirname, '..', 'dist', 'reporting.js'), name], {
            encoding: 'utf8', env: { ...process.env, ...reportEnv, TRADE_FILE: tradesPath, AGGREGATE_FILE: aggregatePath }
        });
        for (const name of ['open', 'unmatched']) {
            const output = run(name);
            assert.match(output, /ETH->STRK.*fallingKnifeCounter: 2/);
            assert.match(output, /STRK->ETH.*fallingKnifeCounter: 3/);
        }
        const matched = run('matched');
        assert.match(matched, /matched fallingKnifeCounter: 4/);
        assert.match(matched, /archived.*matched fallingKnifeCounter: 5/);
        assert.match(run('matched-detail'), /matched fallingKnifeCounter: 4/);
    } finally {
        fs.rmSync(tradesPath, { force: true });
        fs.rmSync(aggregatePath, { force: true });
        fs.rmdirSync(dir);
    }
});

test('extraction and backfill persist the matched counter after opener trades are archived', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trader-archive-test-'));
    const tradesPath = path.join(dir, 'trades.json');
    const aggregatePath = path.join(dir, 'aggregate.json');
    try {
        fs.writeFileSync(tradesPath, JSON.stringify([
            trade('initial', 500, { matchedBy: 'initial' }),
            trade('opener', 1000, { matchedBy: 'closer', fallingKnifeCounter: 4 }),
            trade('closer', 2000, { matchedBy: 'opener', sell: 'strk' })
        ]));
        const run = script => execFileSync(process.execPath, [path.join(__dirname, '..', 'dist', script)], {
            encoding: 'utf8', env: { ...process.env, ...reportEnv, TRADE_FILE: tradesPath, AGGREGATE_FILE: aggregatePath }
        });
        run('extractMatched.js');
        assert.equal(JSON.parse(fs.readFileSync(aggregatePath, 'utf8')).matchedGroups[0].matchedFallingKnifeCounter, 4);
        assert.ok(!JSON.parse(fs.readFileSync(tradesPath, 'utf8')).some(t => t.hash === 'opener'));
        run('backfillAggregate.js');
        assert.equal(JSON.parse(fs.readFileSync(aggregatePath, 'utf8')).matchedGroups[0].matchedFallingKnifeCounter, 4);
    } finally {
        for (const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, name));
        fs.rmdirSync(dir);
    }
});
