const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { recordQuoteRatio, flushQuoteLog, getQuoteLogFile } = require('../dist/quoteLog');

function withDir(fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quotelog-'));
    const prev = process.env.QUOTE_LOG_DIR;
    process.env.QUOTE_LOG_DIR = dir;
    try { fn(dir); } finally {
        if (prev === undefined) delete process.env.QUOTE_LOG_DIR; else process.env.QUOTE_LOG_DIR = prev;
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test('writes header once, keeps first ratio per direction and leaves missing directions empty', () => withDir((dir) => {
    const ts = Date.UTC(2026, 9, 17, 12);
    recordQuoteRatio('strk', '3400000000', ts);
    recordQuoteRatio('strk', '3500000000', ts + 1);
    recordQuoteRatio('eth', '3420000000', ts + 2);
    flushQuoteLog();
    recordQuoteRatio('eth', '3410000000', ts + 10);
    flushQuoteLog();
    flushQuoteLog();
    const file = getQuoteLogFile(dir, ts);
    assert.equal(path.basename(file), 'quotes-2026-10.csv');
    assert.equal(fs.readFileSync(file, 'utf8'),
        `ts,strkToEth,ethToStrk\n${ts},3400000000,3420000000\n${ts + 10},,3410000000\n`);
}));

test('does nothing when QUOTE_LOG_DIR is not set', () => {
    const prev = process.env.QUOTE_LOG_DIR;
    delete process.env.QUOTE_LOG_DIR;
    try {
        recordQuoteRatio('eth', '1', Date.UTC(2026, 9, 17));
        withDir((dir) => { flushQuoteLog(); assert.deepEqual(fs.readdirSync(dir), []); });
    } finally { if (prev !== undefined) process.env.QUOTE_LOG_DIR = prev; }
});
