const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

Object.assign(process.env, {
    SELL_PERCENT: '3', TRADE_DIFFERENCE_1000: '5', MIN_SEL_AMOUNT_ETH: '1000000000000000',
    MIN_SEL_AMOUNT_STRK: '5000000000000000000', MIN_GAS_FEES: '1000000000000000000', TIP: '0'
});
const { loadRows, seedHistory, effectiveCounter, replay, args, comparisonCases, runCases, sortResults } = require('../scripts/replayQuotes.cjs');
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
    assert.equal(result.bestVsHoldPercent, 0);
    assert.equal(result.worstVsHoldPercent, 0);
    assert.equal(result.bestVsHoldHours, 0);
    assert.equal(result.worstVsHoldHours, 0);
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
    assert.deepEqual(args(['--save', '--suite', 'matrix']), { save: true, suite: 'matrix' });
    assert.deepEqual(args(['--out', 'report.json', '--save']), { out: 'report.json', save: true });
    assert.throws(() => args(['--save', 'false']), /Unknown option/);
});

test('CLI defaults to table only and saves only when explicitly requested', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quote-replay-save-'));
    try {
        const trades = path.join(dir, 'trades.json');
        const out = path.join(dir, 'report.json');
        fs.writeFileSync(trades, JSON.stringify(seed));
        fs.writeFileSync(path.join(dir, 'quotes-2026-10.csv'),
            `ts,strkToEth,ethToStrk\n${t0},100000000,100000000\n${t0 + 20000},100000000,100000000\n`);
        const script = path.resolve(__dirname, '..', 'scripts', 'replayQuotes.cjs');
        const dataDir = path.resolve(__dirname, '..', 'data');
        const reports = () => fs.existsSync(dataDir)
            ? fs.readdirSync(dataDir).filter(f => /^quote-replay-.*\.json$/.test(f)).sort() : [];
        const before = reports();
        const run = extra => spawnSync(process.execPath, [
            script, '--workers', '1', '--quotes', dir, '--trades', trades, ...extra
        ], { encoding: 'utf8', timeout: 30000 });
        const table = run([]);
        assert.equal(table.error, undefined);
        assert.equal(table.status, 0, table.stderr);
        assert.match(table.stdout, /bestVsHold/);
        assert.doesNotMatch(table.stdout, /Saved/);
        assert.deepEqual(reports(), before);
        assert.deepEqual(fs.readdirSync(dir).sort(), ['quotes-2026-10.csv', 'trades.json']);
        const saved = run(['--save', '--out', out]);
        assert.equal(saved.status, 0, saved.stderr);
        assert.match(saved.stdout, /Saved/);
        assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).results.length, 2);
        const contents = fs.readFileSync(out, 'utf8');
        const duplicate = run(['--out', out]);
        assert.equal(duplicate.status, 1);
        assert.match(duplicate.stderr, /Output exists or is unsafe/);
        assert.equal(fs.readFileSync(out, 'utf8'), contents);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('best and worst vs hold track every sampled balance including the initial zero', async () => {
    const rows = [
        { ts: t0, strk: 110200000n, eth: 110000000n },
        { ts: t0 + 60000, strk: 107000000n, eth: 106800000n },
        { ts: t0 + 120000, strk: 100000000n, eth: 100000000n },
        { ts: t0 + 180000, strk: 120000000n, eth: null },
        { ts: t0 + 9000000, strk: 120000000n, eth: null }
    ];
    for (const fillLoss of [0, 0.02]) {
        const result = await replay(seed, rows, { ...options, fillLoss });
        const samples = [0];
        let eth = 10, strk = 2000;
        for (const row of rows) {
            const event = result.events.find(e => e.timestamp === row.ts);
            if (event) ({ eth, strk } = event);
            const ratio = Number(row.eth && row.strk ? (row.eth + row.strk) / 2n : row.eth || row.strk) / 100000;
            samples.push(((eth + strk / ratio) / (10 + 2000 / ratio) - 1) * 100);
        }
        assert.equal(result.bestVsHoldPercent, Math.max(...samples));
        assert.equal(result.worstVsHoldPercent, Math.min(...samples));
        const hoursAt = index => index === 0 ? 0 : (rows[index - 1].ts - rows[0].ts) / 3600000;
        assert.equal(result.bestVsHoldHours, hoursAt(samples.indexOf(Math.max(...samples))));
        assert.equal(result.worstVsHoldHours, hoursAt(samples.indexOf(Math.min(...samples))));
        assert.equal(result.vsHoldPercent, samples.at(-1));
    }
});

test('ranking defaults to peak descending and preserves the current baseline after reordering', () => {
    const results = [
        { name: 'current', excessETH: 1, bestVsHoldPercent: 0.123441, worstVsHoldPercent: -2, vsHoldPercent: 1 },
        { name: 'winner', excessETH: 3, bestVsHoldPercent: 0.123449, worstVsHoldPercent: -3, vsHoldPercent: 3 },
        { name: 'tied', excessETH: 2, bestVsHoldPercent: 0.123449, worstVsHoldPercent: -1, vsHoldPercent: 2 }
    ];
    const original = structuredClone(results);
    const ranked = sortResults(results);
    assert.deepEqual(ranked.map(r => r.name), ['winner', 'tied', 'current']);
    assert.deepEqual(ranked.map(r => r.deltaVsCurrentETH), [2, 1, 0]);
    assert.deepEqual(sortResults(results, 'vsHold').map(r => r.name), ['winner', 'tied', 'current']);
    assert.deepEqual(sortResults(results, 'worstVsHold').map(r => r.name), ['tied', 'current', 'winner']);
    assert.deepEqual(sortResults(results, 'excessETH', 'asc').map(r => r.name), ['current', 'tied', 'winner']);
    assert.deepEqual(sortResults(results, 'deltaVsCurrentETH').map(r => r.name), ['winner', 'tied', 'current']);
    assert.deepEqual(sortResults(results, 'setup', 'asc').map(r => r.name), ['current', 'tied', 'winner']);
    assert.deepEqual(results, original);
    assert.throws(() => sortResults(results, 'toString'), /--sort-by/);
    assert.throws(() => sortResults(results, 'bestVsHold', 'invalid'), /--sort-order/);
    assert.throws(() => sortResults(results.slice(1)), /baseline/);
});

test('extended suite covers independent settings and combinations without duplicate decay cases', () => {
    const cases = comparisonCases('extended', 6);
    assert.equal(cases.length, 17);
    assert.equal(cases.filter(c => c.name === 'decay 6h').length, 1);
    assert(cases.some(c => c.sellPercent === 10 && c.decayHours === 0));
    assert(cases.some(c => c.knifeStrength === 1 && c.buybackCap === 1 && c.sellPercent === 5));
    assert.deepEqual(comparisonCases('basic', 6), [
        { name: 'current', decayHours: 0 }, { name: 'decay 6h', decayHours: 6 }
    ]);
    assert.throws(() => comparisonCases('unknown', 6), /--suite/);
});

test('matrix suite covers the complete Cartesian product, with current settings first', () => {
    const cases = comparisonCases('matrix', 6);
    assert.equal(cases.length, 96);
    assert.deepEqual(cases[0], {
        name: 'current', knifeStrength: 2, buybackCap: 2, sellPercent: 3, decayHours: 0
    });
    const key = c => [c.knifeStrength, c.buybackCap, c.sellPercent, c.decayHours].join('|');
    const keys = new Set(cases.map(key));
    assert.equal(keys.size, cases.length);
    assert.equal(new Set(cases.map(c => c.name)).size, cases.length);
    for (const knifeStrength of [2, 1])
        for (const buybackCap of [2, 1])
            for (const sellPercent of [3, 5, 10])
                for (const decayHours of [0, 0.5, 1, 2, 4, 6, 12, 24])
                    assert(keys.has(key({ knifeStrength, buybackCap, sellPercent, decayHours })));
    const custom = comparisonCases('matrix', 3);
    assert.equal(custom.length, 108);
    assert.equal(custom.filter(c => c.decayHours === 3).length, 12);
});

test('worker pool matches sequential results, preserves order and leaves inputs unchanged', async () => {
    const rows = [
        { ts: t0, strk: 110200000n, eth: 110000000n },
        { ts: t0 + 60000, strk: 107000000n, eth: 106800000n },
        { ts: t0 + 120000, strk: 100000000n, eth: 100000000n }
    ];
    const cases = comparisonCases('extended', 6);
    const original = structuredClone({ seed, rows, options, cases });
    const serial = await runCases(seed, rows, options, cases, 1);
    const started = [];
    const parallel = await runCases(seed, rows, options, cases, 2,
        (candidate, index) => started.push([candidate.name, index]));
    assert.deepEqual(parallel, serial);
    assert.deepEqual(started, cases.map((candidate, index) => [candidate.name, index]));
    assert.deepEqual({ seed, rows, options, cases }, original);
    assert.deepEqual(await runCases(seed, rows, options, cases.slice(0, 2), 8), serial.slice(0, 2));
    assert.deepEqual(await runCases(seed, rows, options, [], 2), []);
});

test('worker pool rejects invalid worker counts and propagates replay and scheduling failures', async () => {
    const cases = comparisonCases('basic', 6);
    for (const workers of [0, -1, 1.5, NaN, Infinity])
        await assert.rejects(runCases(seed, [], options, cases, workers), /--workers must be a positive integer/);
    await assert.rejects(runCases(seed, [], options, cases, 2), /Replay ".*" failed: At least two quotes/);
    await assert.rejects(runCases(seed, [], options, cases, 1), /At least two quotes/);
    await assert.rejects(runCases(seed, [], options, cases, 2, () => {
        throw new Error('progress callback failed');
    }), /progress callback failed/);
});

test('matrix CLI writes a complete ordered report and deduplicates configured opening sizes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quote-replay-matrix-'));
    try {
        const trades = path.join(dir, 'trades.json');
        const out = path.join(dir, 'report.json');
        fs.writeFileSync(trades, JSON.stringify(seed));
        fs.writeFileSync(path.join(dir, 'quotes-2026-10.csv'),
            `ts,strkToEth,ethToStrk\n${t0},100000000,100000000\n${t0 + 20000},100000000,100000000\n`);
        const cli = spawnSync(process.execPath, [
            path.resolve(__dirname, '..', 'scripts', 'replayQuotes.cjs'),
            '--suite', 'matrix', '--workers', '2', '--quotes', dir, '--trades', trades, '--out', out
        ], { encoding: 'utf8', env: { ...process.env, SELL_PERCENT: '5' }, timeout: 30000 });
        assert.equal(cli.error, undefined);
        assert.equal(cli.status, 0, cli.stderr);
        const report = JSON.parse(fs.readFileSync(out, 'utf8'));
        assert.equal(report.results.length, 64);
        assert.equal(report.results[0].name, 'current');
        assert.equal(report.results[0].options.sellPercent, 5);
        assert.equal(report.results[0].options.decayHours, 0);
        const settings = report.results.map(r => [
            r.options.knifeStrength, r.options.buybackCap, r.options.sellPercent, r.options.decayHours
        ].join('|'));
        assert.equal(new Set(settings).size, 64);
        assert(report.results.every(r => r.events.length === 0 && r.excessETH === 0));
        assert(report.results.every(r => r.bestVsHoldPercent === 0 && r.deltaVsCurrentETH === 0));
        assert.deepEqual(report.sorting, { column: 'bestVsHold', order: 'desc' });
        assert.match(cli.stdout, /bestVsHold/);
        assert.match(cli.stdout, /o\/c\/n/);
        assert.match(cli.stdout, /0\/0\/0/);
        assert.match(cli.stdout, /0\.0000% \(0\.00h\)/);
        assert.doesNotMatch(cli.stdout, /\b(opens|closes|newPositionsLeft|excessETH)\b/);
        assert(report.results.every(r => r.bestVsHoldHours === 0 && r.worstVsHoldHours === 0));
        assert.match(cli.stdout, /Saved/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('CLI applies selected sorting to the report and rejects invalid sort options', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quote-replay-sort-'));
    try {
        const trades = path.join(dir, 'trades.json');
        fs.writeFileSync(trades, JSON.stringify(seed));
        fs.writeFileSync(path.join(dir, 'quotes-2026-10.csv'),
            `ts,strkToEth,ethToStrk\n${t0},110200000,110000000\n${t0 + 60000},107000000,106800000\n`);
        const script = path.resolve(__dirname, '..', 'scripts', 'replayQuotes.cjs');
        const run = extra => spawnSync(process.execPath, [
            script, '--suite', 'extended', '--workers', '1', '--quotes', dir, '--trades', trades, ...extra
        ], { encoding: 'utf8', timeout: 30000 });
        for (const [index, extra] of [
            [], ['--sort-by', 'excessETH', '--sort-order', 'asc']
        ].entries()) {
            const out = path.join(dir, `report-${index}.json`);
            const cli = run(['--out', out, ...extra]);
            assert.equal(cli.error, undefined);
            assert.equal(cli.status, 0, cli.stderr);
            const { results, sorting } = JSON.parse(fs.readFileSync(out, 'utf8'));
            const key = index === 0 ? 'bestVsHoldPercent' : 'excessETH';
            assert(results.some(r => r[key] !== results[0][key]));
            assert(results.every((r, i) => i === 0 || (index === 0
                ? results[i - 1][key] >= r[key] : results[i - 1][key] <= r[key])));
            assert.deepEqual(sorting, index === 0
                ? { column: 'bestVsHold', order: 'desc' } : { column: 'excessETH', order: 'asc' });
            const baseline = results.find(r => r.name === 'current');
            assert(results.every(r => r.deltaVsCurrentETH === r.excessETH - baseline.excessETH));
            for (const r of results) {
                assert.match(cli.stdout, new RegExp(`${r.opens}/${r.closes}/${r.newPositionsLeft}`));
                for (const kind of ['best', 'worst']) {
                    const cell = `${r[`${kind}VsHoldPercent`].toFixed(4)}% (${r[`${kind}VsHoldHours`].toFixed(2)}h)`;
                    assert(cli.stdout.includes(cell), `Missing table cell: ${cell}`);
                }
            }
        }
        for (const extra of [['--sort-by', 'invalid'], ['--sort-order', 'invalid']]) {
            const cli = run(extra);
            assert.equal(cli.status, 1);
            assert.match(cli.stderr, /--sort-(by|order) must be/);
        }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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
