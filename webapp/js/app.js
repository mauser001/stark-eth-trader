const STORAGE_KEY = 'trader_viewer_password';
const LAST_HASH_KEY = 'trader_last_trade_hash';
const POLL_INTERVAL_MS = 30000;

function formatWei(weiStr, decimals = 5) {
    if (weiStr == null) return '-';
    let neg = false;
    let s = String(weiStr);
    if (s.startsWith('-')) { neg = true; s = s.slice(1); }
    s = s.padStart(19, '0');
    const intPart = s.slice(0, -18).replace(/^0+(?=\d)/, '') || '0';
    const fracPart = s.slice(-18).slice(0, decimals);
    return (neg ? '-' : '') + intPart + '.' + fracPart;
}

function formatDate(ts) {
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: '2-digit' }) +
        ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function formatShortDate(ts) {
    return new Date(ts).toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: '2-digit' });
}

let storedPassword = null;

async function fetchData(password) {
    const res = await fetch('data.php', {
        headers: { 'X-Viewer-Password': password }
    });
    if (!res.ok) {
        const err = new Error('request failed: ' + res.status);
        err.status = res.status;
        throw err;
    }
    return res.json();
}

function showDashboard() {
    document.getElementById('login-overlay').classList.add('hidden');
    document.getElementById('dashboard').classList.remove('hidden');
}

function showLogin(message) {
    document.getElementById('dashboard').classList.add('hidden');
    document.getElementById('login-overlay').classList.remove('hidden');
    document.getElementById('login-error').textContent = message || '';
}

function renderCurrent(current) {
    if (!current) return;
    document.getElementById('balance-eth').textContent = formatWei(current.eth) + ' ETH';
    document.getElementById('balance-strk').textContent = formatWei(current.strk) + ' STRK';
    document.getElementById('last-updated').textContent = 'Last trade: ' + formatDate(current.timestamp);
}

let balancesChart, dailyChart;
let currentRange = 'all';

// local day key (YYYY-MM-DD), matches the format the balances/turningPoints dates use
function dayKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`;
}

function filterByRange(balances, range) {
    if (range === 'all' || !balances.length) return balances;
    const days = range === 'week' ? 7 : 30;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const cutoffKey = dayKey(cutoff);
    return balances.filter(b => b.date >= cutoffKey);
}

function renderBalancesChart(balances, turningPoints) {
    const filtered = filterByRange(balances, currentRange);
    const labels = filtered.map(b => b.date);
    const eth = filtered.map(b => Number(formatWei(b.eth, 8)));
    const strk = filtered.map(b => Number(formatWei(b.strk, 8)));

    // mark balance "turning points" (direction reversals from the backwards report) on the
    // eth line - null everywhere else so the point is only drawn on that day
    const turningByDate = new Map((turningPoints || []).map(p => [p.date, p]));
    const turningPointData = filtered.map((b, i) => turningByDate.has(b.date) ? eth[i] : null);
    const turningPointColors = filtered.map(b => turningByDate.get(b.date)?.direction === 'up' ? '#33c17a' : '#ef5b5b');

    const ctx = document.getElementById('chart-balances');
    if (balancesChart) balancesChart.destroy();
    balancesChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [
                { label: 'ETH', data: eth, borderColor: '#5b8cff', backgroundColor: 'transparent', yAxisID: 'yEth', tension: 0.25, pointRadius: 0 },
                { label: 'STRK', data: strk, borderColor: '#33c17a', backgroundColor: 'transparent', yAxisID: 'yStrk', tension: 0.25, pointRadius: 0 },
                {
                    label: 'Turning point', data: turningPointData, yAxisID: 'yEth', showLine: false,
                    pointRadius: turningPointData.map(v => v == null ? 0 : 10),
                    pointHoverRadius: turningPointData.map(v => v == null ? 0 : 12),
                    pointStyle: 'triangle',
                    pointBackgroundColor: turningPointColors,
                    pointBorderColor: '#e6e9ef',
                    pointBorderWidth: turningPointData.map(v => v == null ? 0 : 1.5)
                }
            ]
        },
        options: {
            responsive: true,
            interaction: { mode: 'index', intersect: false },
            scales: {
                yEth: { position: 'left', title: { display: true, text: 'ETH' }, grid: { color: '#262c35' } },
                yStrk: { position: 'right', title: { display: true, text: 'STRK' }, grid: { display: false } },
                x: { grid: { color: '#262c35' } }
            },
            plugins: {
                legend: { labels: { color: '#e6e9ef' } },
                tooltip: {
                    callbacks: {
                        afterBody: (items) => {
                            const point = turningByDate.get(items[0]?.label);
                            if (!point) return '';
                            const arrow = point.direction === 'up' ? '▲' : '▼';
                            return `${arrow} Eth: ${formatWei(point.diffEth, 8)} | Strk: ${formatWei(point.diffStrk, 8)}`;
                        }
                    }
                }
            }
        }
    });
}

function renderDailyChart(daily) {
    const labels = daily.map(d => d.date);
    const net = daily.map(d => Number(formatWei(d.netEth, 8)));
    const counts = daily.map(d => d.tradeCount);

    const ctx = document.getElementById('chart-daily');
    if (dailyChart) dailyChart.destroy();
    dailyChart = new Chart(ctx, {
        data: {
            labels,
            datasets: [
                {
                    type: 'bar',
                    label: 'Net ETH',
                    data: net,
                    backgroundColor: net.map(v => v < 0 ? '#ef5b5b' : '#33c17a'),
                    yAxisID: 'yEth'
                },
                {
                    type: 'line',
                    label: 'Trades',
                    data: counts,
                    borderColor: '#5b8cff',
                    backgroundColor: 'transparent',
                    yAxisID: 'yCount',
                    tension: 0.25,
                    pointRadius: 2
                }
            ]
        },
        options: {
            responsive: true,
            scales: {
                yEth: { position: 'left', title: { display: true, text: 'Net ETH' }, grid: { color: '#262c35' } },
                yCount: { position: 'right', title: { display: true, text: '# trades' }, grid: { display: false } },
                x: { grid: { color: '#262c35' } }
            },
            plugins: { legend: { labels: { color: '#e6e9ef' } } }
        }
    });
}

function renderTrades(trades) {
    const body = document.getElementById('trades-body');
    body.innerHTML = '';
    const rows = [...trades].reverse();
    for (const t of rows) {
        const tr = document.createElement('tr');
        const direction = t.sell === 'eth' ? 'ETH → STRK' : 'STRK → ETH';
        const netCell = t.netEth != null
            ? `<span class="${t.netEth.startsWith('-') ? 'neg' : 'pos'}">${formatWei(t.netEth, 6)}</span>`
            : '-';
        const isLoss = t.netEth != null && t.netEth.startsWith('-');
        const sameDay = formatShortDate(t.fromTimestamp) === formatShortDate(t.toTimestamp);
        const range = sameDay ? formatShortDate(t.fromTimestamp) : `${formatShortDate(t.fromTimestamp)} – ${formatShortDate(t.toTimestamp)}`;
        const statusCell = t.status === 'closed'
            ? `<span class="${isLoss ? 'neg' : 'pos'}">${isLoss ? 'Loss' : 'Profit'}</span><span class="status-detail">${t.tradeCount} trade(s) · ${range}</span>`
            : `<span class="status-open">Open</span>`;
        tr.innerHTML = `
            <td>${formatDate(t.timestamp)}</td>
            <td>${direction}</td>
            <td>${formatWei(t.sellAmount, 6)}</td>
            <td>${formatWei(t.buyAmount, 6)}</td>
            <td>${t.actualFees ? formatWei(t.actualFees, 6) : '-'}</td>
            <td>${statusCell}</td>
            <td>${netCell}</td>
        `;
        body.appendChild(tr);
    }
}

let latestData = null;

function render(data) {
    latestData = data;
    renderCurrent(data.current);
    renderBalancesChart(data.balances || [], data.turningPoints || []);
    renderDailyChart(data.dailyMatched || []);
    renderTrades(data.trades || []);
}

async function tryLoad(password) {
    const data = await fetchData(password);
    render(data);
    showDashboard();
    storedPassword = password;
    if (data.current) localStorage.setItem(LAST_HASH_KEY, data.current.hash);
}

document.getElementById('range-buttons').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-range]');
    if (!btn) return;
    currentRange = btn.dataset.range;
    for (const b of document.querySelectorAll('#range-buttons button')) b.classList.toggle('active', b === btn);
    if (latestData) renderBalancesChart(latestData.balances || [], latestData.turningPoints || []);
});

// ---------------------------------------------------------------------------
// browser notifications: poll data.php in the background and alert on new trades
// ---------------------------------------------------------------------------

function updateNotifyButton() {
    const btn = document.getElementById('notify-btn');
    if (!('Notification' in window)) {
        btn.textContent = 'Alerts unsupported';
        btn.disabled = true;
        return;
    }
    if (Notification.permission === 'granted') {
        btn.textContent = 'Alerts on';
        btn.classList.add('active');
    } else {
        btn.textContent = 'Enable alerts';
        btn.classList.remove('active');
    }
}

document.getElementById('notify-btn').addEventListener('click', async () => {
    if (!('Notification' in window)) return;
    await Notification.requestPermission();
    updateNotifyButton();
});

async function pollForNewTrade() {
    if (!storedPassword || document.hidden) return;
    try {
        const data = await fetchData(storedPassword);
        const lastSeenHash = localStorage.getItem(LAST_HASH_KEY);
        const newTrade = data.current && data.current.hash !== lastSeenHash;
        render(data);
        if (newTrade && data.current) {
            localStorage.setItem(LAST_HASH_KEY, data.current.hash);
            if ('Notification' in window && Notification.permission === 'granted') {
                const latestTrade = (data.trades || [])[data.trades.length - 1];
                const detail = latestTrade
                    ? `${latestTrade.sell === 'eth' ? 'ETH → STRK' : 'STRK → ETH'}: sold ${formatWei(latestTrade.sellAmount, 4)}, bought ${formatWei(latestTrade.buyAmount, 4)}`
                    : '';
                new Notification('New trade executed', { body: detail });
            }
        }
    } catch (e) {
        // ignore transient poll failures, next interval will retry
    }
}

async function init() {
    updateNotifyButton();
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
        try {
            await tryLoad(stored);
            setInterval(pollForNewTrade, POLL_INTERVAL_MS);
            return;
        } catch (e) {
            localStorage.removeItem(STORAGE_KEY);
        }
    }
    showLogin();
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = document.getElementById('login-password').value;
    try {
        await tryLoad(password);
        localStorage.setItem(STORAGE_KEY, password);
        setInterval(pollForNewTrade, POLL_INTERVAL_MS);
    } catch (err) {
        showLogin('Wrong password, try again.');
    }
});

init();
