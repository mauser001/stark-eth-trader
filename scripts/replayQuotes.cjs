const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const quoteFile = path.join(root, 'dist', 'quote.js');
const localRequire = createRequire(quoteFile);
const HOUR = 3600000;
const units = n => Number(n) / 1e18;
const bn = n => localRequire('@ethersproject/bignumber').BigNumber.from(n.toString());

function loadRows(dir) {
    const byTimestamp = new Map();
    const files = fs.readdirSync(dir).filter(f => /^quotes-\d{4}-\d{2}\.csv$/.test(f)).sort();
    if (!files.length) throw new Error(`No monthly quote CSVs in ${dir}`);
    let incompleteLines = 0;
    for (const file of files) {
        const text = fs.readFileSync(path.join(dir, file), 'utf8');
        const end = text.lastIndexOf('\n');
        if (end < 0) throw new Error(`Missing complete CSV header: ${file}`);
        if (end !== text.length - 1) incompleteLines++;
        const lines = text.slice(0, end).split(/\r?\n/);
        if (lines.shift() !== 'ts,strkToEth,ethToStrk') throw new Error(`Unexpected header: ${file}`);
        for (const [i, line] of lines.entries()) {
            if (!line) continue;
            const cells = line.split(',');
            const [ts, strk, eth] = cells;
            if (cells.length !== 3 || !/^\d+$/.test(ts) || ![strk, eth].every(v => v === '' || /^[1-9]\d*$/.test(v))
                || (!strk && !eth) || !Number.isSafeInteger(Number(ts)) || !Number.isFinite(new Date(Number(ts)).getTime()))
                throw new Error(`Invalid quote at ${file}:${i + 2}`);
            if (byTimestamp.has(Number(ts))) throw new Error(`Duplicate timestamp ${ts}`);
            byTimestamp.set(Number(ts), { ts: Number(ts), strk: strk ? BigInt(strk) : null, eth: eth ? BigInt(eth) : null });
        }
    }
    return { rows: [...byTimestamp.values()].sort((a, b) => a.ts - b.ts), files, incompleteLines };
}

function seedHistory(trades, ts) {
    const byHash = new Map(trades.map(t => [t.hash, t]));
    if (byHash.size !== trades.length) throw new Error('Duplicate hashes in trade history');
    const hist = structuredClone(trades.filter(t => (t.timestamp || 0) < ts));
    for (const t of hist) {
        const closer = byHash.get(t.matchedBy);
        if (closer && closer.timestamp >= ts) delete t.matchedBy;
    }
    const last = hist.at(-1);
    if (!last?.balanceEth || !last?.balanceStrk || last.status !== 'SUCCEEDED')
        throw new Error('Replay start needs a preceding confirmed trade with wallet balances');
    if (hist.some(t => t.sell && (!t.sellAmount || !t.buyAmount)))
        throw new Error('Incomplete trade amounts in seed');
    if (hist.filter(t => t.sell && !t.matchedBy).some(t => t.sell !== 'eth'))
        throw new Error('This replay currently supports ETH-sell open inventory only');
    return hist;
}

function effectiveCounter(raw, now, lastOpening, decayHours) {
    return Math.max(0, raw - (decayHours > 0 ? Math.floor(Math.max(0, now - lastOpening) / (decayHours * HOUR)) : 0));
}

function markRatio(row) {
    return Number(row.eth && row.strk ? (row.eth + row.strk) / 2n : row.eth || row.strk) / 100000;
}

// Evaluate the compiled production module with only its external quote feed, logging
// and retry timer replaced. No account/provider or SDK network call is created.
function offlineQuotes(fetchQuotes, constants) {
    const code = fs.readFileSync(quoteFile, 'utf8');
    const mod = { exports: {} };
    const requireOffline = name => {
        if (name === '@avnu/avnu-sdk') return { getQuotes: fetchQuotes };
        if (name === './quoteLog') return { recordQuoteRatio() {} };
        if (name === './conts') return constants;
        return localRequire(name);
    };
    const context = vm.createContext({ console: { log() {}, warn() {}, error() {} },
        process: { env: { ETH_TOKEN: 'eth', STARK_TOKEN: 'strk' } },
        setTimeout: callback => callback() });
    const load = vm.runInContext('(function(require,module,exports){' + code + '\n})', context, { filename: quoteFile });
    load(requireOffline, mod, mod.exports);
    return mod.exports;
}

async function replay(trades, rows, options) {
    if (rows.length < 2) throw new Error('At least two quotes are required');
    const defaults = localRequire('./conts');
    const c = { ...defaults,
        FALLING_KNIFE_STRENGTH: options.knifeStrength ?? defaults.FALLING_KNIFE_STRENGTH,
        FALLING_KNIFE_BUYBACK_CAP: options.buybackCap ?? defaults.FALLING_KNIFE_BUYBACK_CAP,
        SELL_PERCENT: bn(options.sellPercent ?? defaults.SELL_PERCENT.toString())
    };
    const settings = { ...options, knifeStrength: c.FALLING_KNIFE_STRENGTH,
        buybackCap: c.FALLING_KNIFE_BUYBACK_CAP, sellPercent: c.SELL_PERCENT.toNumber() };
    const trend = localRequire('./trendGap');
    const hist = seedHistory(trades, rows[0].ts);
    const seedHashes = new Set(hist.map(t => t.hash));
    let eth = BigInt(hist.at(-1).balanceEth), strk = BigInt(hist.at(-1).balanceStrk);
    const initialEth = eth, initialStrk = strk;
    let lastOpening = Math.max(0, ...hist.filter(t => t.sell && !t.matchedBy).map(t => t.timestamp || 0));
    let lastTrade = 0, current, open, best, knife, maxFee, trendGap, trendHour = -1, trendDirty = true;
    let minVsHold = 1, minEth = units(eth);
    const events = [];
    const gas = BigInt(Math.round(options.gas * 1e18));
    const q = offlineQuotes(async request => {
        const sell = request.sellTokenAddress, ratio = current[sell];
        if (!ratio) return [];
        const amount = request.sellAmount;
        const buy = sell === 'eth' ? amount * ratio / 100000n : amount * 100000n / ratio;
        return [{ sellAmount: amount, buyAmount: buy, gasFees: 0n, estimatedSlippage: options.slippage }];
    }, c);
    function refresh() {
        open = hist.filter(t => !t.matchedBy && t.sell);
        best = q.getBestTx(open) || hist.at(-1);
        knife = q.getFallingKnife(hist);
        maxFee = hist.slice(-10).reduce((v, t) => t.actualFees && BigInt(t.actualFees) > v ? BigInt(t.actualFees) : v, 0n);
        trendDirty = true;
    }
    refresh();
    for (current of rows) {
        const hour = Math.floor(current.ts / HOUR);
        if (trendDirty || hour !== trendHour) {
            trendHour = hour;
            trendDirty = false;
            trendGap = trend.getTrendGap(trend.toRatioPoints(hist), current.ts, {
                days: c.TREND_GAP_DAYS, move: c.TREND_GAP_MOVE_1000 / 1000,
                volK: c.TREND_GAP_VOL_K, volDays: c.TREND_GAP_VOL_DAYS,
                maxMult: c.TREND_GAP_MAX_MULT, baseDifference: c.TRADE_DIFFERENCE_1000.toNumber() / 1000
            });
        }
        const counter = effectiveCounter(knife.counter, current.ts, lastOpening, options.decayHours);
        if (current.ts - lastTrade >= options.cooldown * 1000) {
            for (const sell of ['strk', 'eth']) {
                if (!current[sell]) continue;
                const matching = !best.matchedBy && best.sell !== sell;
                const balance = sell === 'eth' ? eth : strk;
                const minimum = BigInt((sell === 'eth' ? c.MIN_SEL_AMOUNT_ETH : c.MIN_SEL_AMOUNT_STRK).toString());
                if (balance < minimum) continue;
                const pct = balance * BigInt(c.SELL_PERCENT.gt(100) ? 100 : c.SELL_PERCENT.toString()) / 100n;
                const amount = matching ? BigInt(best.buyAmount) : pct > minimum ? pct : minimum;
                if (amount > balance) continue;
                const target = matching ? q.getTxRatio(best.sell, bn(best.sellAmount), bn(best.buyAmount))
                    : q.getBestRatio(sell, open.length ? open : [hist.at(-1)]);
                const gap = counter > 0 && knife.sell === sell
                    ? c.TRADE_DIFFERENCE_1000.mul(1 + c.FALLING_KNIFE_STRENGTH * counter) : c.TRADE_DIFFERENCE_1000;
                const data = await q.getQuote(sell, bn(amount), { address: 'offline' }, {}, target,
                    best, open, bn(options.failedFees), bn(maxFee), gap, trendGap);
                if (!data?.quote) continue;
                const sa = BigInt(data.quote.sellAmount);
                const buy = BigInt(data.quote.buyAmount) * BigInt(1000000 - Math.round(options.fillLoss * 1e6)) / 1000000n;
                const nextEth = eth + (sell === 'eth' ? -sa : buy);
                const nextStrk = strk + (sell === 'eth' ? buy - gas : -sa - gas);
                if (nextEth < 0n || nextStrk < 0n) continue;
                const hash = `replay-${events.length}`;
                const originals = (data.matchedTx || []).map(h => {
                    const t = hist.find(t => t.hash === h);
                    assert(t && !t.matchedBy, 'Cannot close an already matched position');
                    return t;
                });
                originals.forEach(t => { t.matchedBy = hash; });
                hist.push({
                    hash, sell, timestamp: current.ts, status: 'SUCCEEDED',
                    sellAmount: (sell === 'eth' ? eth - nextEth : strk - nextStrk).toString(),
                    buyAmount: (sell === 'eth' ? nextStrk - strk : nextEth - eth).toString(),
                    balanceEth: nextEth.toString(), balanceStrk: nextStrk.toString(), actualFees: gas.toString(),
                    ...(data.wasMatch ? { matchedBy: originals[0].hash } : {}),
                    ...(!data.wasMatch && counter > 0 && knife.sell === sell ? { fallingKnifeCounter: counter } : {})
                });
                events.push({ timestamp: current.ts, utc: new Date(current.ts).toISOString(), sell,
                    close: !!data.wasMatch, matchedPositions: originals.length,
                    counter, gapPerMille: gap.toNumber(), eth: units(nextEth), strk: units(nextStrk) });
                eth = nextEth; strk = nextStrk;
                lastTrade = current.ts;
                if (!data.wasMatch) lastOpening = current.ts;
                if (data.wasMatch) options = { ...options, failedFees: '0' };
                refresh();
                break;
            }
        }
        const m = markRatio(current);
        minVsHold = Math.min(minVsHold, (units(eth) + units(strk) / m) / (units(initialEth) + units(initialStrk) / m));
        minEth = Math.min(minEth, units(eth));
    }
    const m = markRatio(rows.at(-1));
    const hold = units(initialEth) + units(initialStrk) / m;
    const value = units(eth) + units(strk) / m;
    return { options: settings, opens: events.filter(t => !t.close).length, closes: events.filter(t => t.close).length,
        newPositionsLeft: hist.filter(t => !seedHashes.has(t.hash) && !t.matchedBy).length,
        eth: units(eth), strk: units(strk), minEth, excessETH: value - hold,
        vsHoldPercent: (value / hold - 1) * 100, worstVsHoldPercent: (minVsHold - 1) * 100, events };
}

function comparisonCases(suite, decayHours) {
    const cases = [{ name: 'current', decayHours: 0 }, { name: `decay ${decayHours}h`, decayHours }];
    if (suite === 'basic') return cases;
    if (suite !== 'extended') throw new Error('--suite must be basic or extended');
    cases.push(
        { name: 'knife +0.5pp', decayHours: 0, knifeStrength: 1 },
        { name: 'base buyback only', decayHours: 0, buybackCap: 1 },
        ...[5, 10].map(sellPercent => ({ name: `size ${sellPercent}%`, decayHours: 0, sellPercent })),
        ...[2, 4, 6, 12, 24].filter(h => h !== decayHours).map(h => ({ name: `decay ${h}h`, decayHours: h })),
        { name: `+0.5pp / decay ${decayHours}h`, decayHours, knifeStrength: 1 },
        { name: `base BB / decay ${decayHours}h`, decayHours, buybackCap: 1 },
        { name: '+0.5pp / base BB', decayHours: 0, knifeStrength: 1, buybackCap: 1 },
        { name: `size 5% / decay ${decayHours}h`, decayHours, sellPercent: 5 },
        { name: `+0.5pp / base BB / size 5% / decay ${decayHours}h`,
            decayHours, knifeStrength: 1, buybackCap: 1, sellPercent: 5 }
    );
    return cases;
}

function args(argv) {
    const result = {};
    const known = new Set(['suite', 'quotes', 'trades', 'out', 'from', 'to', 'decay-hours', 'gas-strk', 'slippage', 'fill-loss', 'cooldown', 'failed-fees-strk']);
    for (let i = 0; i < argv.length; i += 2) {
        const key = argv[i].replace(/^--/, '');
        if (!argv[i].startsWith('--') || !known.has(key) || !argv[i + 1] || argv[i + 1].startsWith('--'))
            throw new Error(`Unknown option or missing value: ${argv[i]}`);
        result[key] = argv[i + 1];
    }
    return result;
}

async function main(argv) {
    if (argv.includes('--help')) {
        console.log('Offline current vs decay replay. Run using npm run replay-quotes-prod -- [options]\n'
            + '--quotes DIR --trades FILE --out FILE --from ISO_TIME --to ISO_TIME\n'
            + '--decay-hours 6 --gas-strk 0.23 --slippage 0.003 --fill-loss 0 --cooldown 20 --failed-fees-strk 0\n'
            + '--suite basic|extended (default basic; extended adds knife, buyback, size and decay comparisons)\n'
            + 'Fractions: 0.003 = 0.3%. Times require Z or an explicit UTC offset. No live data is modified.');
        return;
    }
    const a = args(argv);
    const numeric = (key, fallback, max = Infinity) => {
        const n = Number(a[key] ?? fallback);
        if (!Number.isFinite(n) || n < 0 || n > max) throw new Error(`Invalid --${key}`);
        return n;
    };
    const time = key => {
        if (!a[key]) return undefined;
        if (!/(Z|[+-]\d{2}:\d{2})$/.test(a[key]) || !Number.isFinite(Date.parse(a[key])))
            throw new Error(`--${key} needs an ISO timestamp with timezone`);
        return Date.parse(a[key]);
    };
    const from = time('from'), to = time('to');
    const source = loadRows(a.quotes || process.env.QUOTE_LOG_DIR || path.join(root, 'data', 'quote_logs'));
    const rows = source.rows.filter(r => (from === undefined || r.ts >= from) && (to === undefined || r.ts <= to));
    if (rows.length < 2) throw new Error('Selected window has fewer than two quotes');
    const tradePath = a.trades || process.env.TRADE_FILE;
    if (!tradePath) throw new Error('Set TRADE_FILE or pass --trades');
    const out = path.resolve(a.out || path.join(root, 'data', `quote-replay-${Date.now()}.json`));
    if (out === path.resolve(tradePath) || path.extname(out) !== '.json' || fs.existsSync(out))
        throw new Error('Output exists or is unsafe. Pass --out with a new JSON filename.');
    const trades = JSON.parse(fs.readFileSync(tradePath, 'utf8'));
    const common = {
        gas: numeric('gas-strk', .23), slippage: numeric('slippage', .003, .99),
        fillLoss: numeric('fill-loss', 0, .99), cooldown: numeric('cooldown', 20),
        failedFees: BigInt(Math.round(numeric('failed-fees-strk', 0) * 1e18)).toString()
    };
    const decayHours = numeric('decay-hours', 6);
    if (decayHours === 0) throw new Error('--decay-hours must be positive');
    const cases = comparisonCases(a.suite || 'basic', decayHours);
    console.log(`Replaying ${rows.length} rows: ${new Date(rows[0].ts).toISOString()} to ${new Date(rows.at(-1).ts).toISOString()}`);
    console.warn('Indicative replay: fixed gas/slippage; size-independent re-quotes; hourly trend refresh; no failed executions.\n'
        + 'Keep a complete trade-history snapshot: archiving old trades can invalidate historical seeds.');
    const results = [];
    for (const candidate of cases) {
        console.log(`Running ${results.length + 1}/${cases.length}: ${candidate.name}`);
        const result = await replay(trades, rows, { ...common, ...candidate });
        results.push({ name: candidate.name, ...result });
    }
    const missing = { strk: rows.filter(r => !r.strk).length, eth: rows.filter(r => !r.eth).length };
    const gaps = rows.slice(1).filter((r, i) => r.ts - rows[i].ts > 60000).length;
    if (gaps || missing.strk || missing.eth || source.incompleteLines)
        console.warn('Coverage warnings:', { gapsOver60s: gaps, missing, ignoredIncompleteTrailingLines: source.incompleteLines });
    console.table(results.map(r => ({
        setup: r.name, opens: r.opens, closes: r.closes,
        newPositionsLeft: r.newPositionsLeft, excessETH: r.excessETH.toFixed(6),
        deltaVsCurrentETH: (r.excessETH - results[0].excessETH).toFixed(6),
        vsHold: r.vsHoldPercent.toFixed(4) + '%',
        worstVsHold: r.worstVsHoldPercent.toFixed(4) + '%', minETH: r.minEth.toFixed(4)
    })));
    const report = {
        start: new Date(rows[0].ts).toISOString(), end: new Date(rows.at(-1).ts).toISOString(),
        rows: rows.length, files: source.files, tradePath: path.resolve(tradePath), missing, gapsOver60s: gaps,
        assumptions: common,
        constants: Object.fromEntries(Object.entries(localRequire('./conts')).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v])),
        actualTrades: trades.filter(t => t.timestamp >= rows[0].ts && t.timestamp <= rows.at(-1).ts)
            .map(t => ({ timestamp: t.timestamp, sell: t.sell, hash: t.hash })),
        results
    };
    fs.mkdirSync(path.dirname(out), { recursive: true });
    // Exclusive creation prevents accidentally overwriting input files or previous results.
    fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(`Saved ${out}`);
}

module.exports = { loadRows, seedHistory, effectiveCounter, replay, args, comparisonCases };
if (require.main === module) main(process.argv.slice(2)).catch(e => { console.error(e.message); process.exitCode = 1; });
