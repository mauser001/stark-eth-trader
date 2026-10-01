// Service worker: best-effort background notifications about new trades even when no dashboard
// tab is open, via the Periodic Background Sync API (Chromium browsers only, and only fires
// reliably once the dashboard is installed as a PWA). Where unsupported this simply never fires -
// the page's own foreground polling (app.js pollForNewTrade) keeps working regardless.
// Bump the ?v= query param on the service worker registration in app.js when this file changes.

const DB_NAME = 'trader-sw';
const STORE = 'kv';

function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function idbGet(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function idbSet(key, value) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

// duplicated (rather than shared) since service workers can't import the page's globals
function formatWei(weiStr, decimals = 4) {
    if (weiStr == null) return '-';
    let neg = false;
    let s = String(weiStr);
    if (s.startsWith('-')) { neg = true; s = s.slice(1); }
    s = s.padStart(19, '0');
    const intPart = s.slice(0, -18).replace(/^0+(?=\d)/, '') || '0';
    const fracPart = s.slice(-18).slice(0, decimals);
    return (neg ? '-' : '') + intPart + '.' + fracPart;
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// the page sends the viewer password once logged in, so the worker can poll data.php on its own
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'set-password') {
        event.waitUntil(idbSet('password', event.data.password));
    }
});

async function checkForNewTrade() {
    const password = await idbGet('password');
    if (!password) return;
    const res = await fetch('data.php', { headers: { 'X-Viewer-Password': password } });
    if (!res.ok) return;
    const data = await res.json();
    const current = data.current;
    if (!current) return;

    const lastHash = await idbGet('lastHash');
    await idbSet('lastHash', current.hash);
    if (!lastHash || lastHash === current.hash) return; // first run or no change: don't notify

    const latestTrade = (data.trades || [])[data.trades.length - 1];
    const detail = latestTrade
        ? `${latestTrade.sell === 'eth' ? 'ETH → STRK' : 'STRK → ETH'}: sold ${formatWei(latestTrade.sellAmount)}, bought ${formatWei(latestTrade.buyAmount)}`
        : '';
    await self.registration.showNotification('New trade executed', { body: detail, tag: 'trader-new-trade' });
}

self.addEventListener('periodicsync', (event) => {
    if (event.tag === 'poll-trades') event.waitUntil(checkForNewTrade());
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil(self.clients.openWindow('./'));
});
