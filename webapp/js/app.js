const STORAGE_KEY = 'trader_viewer_password';

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

function renderBalancesChart(balances) {
    const labels = balances.map(b => b.date);
    const eth = balances.map(b => Number(formatWei(b.eth, 8)));
    const strk = balances.map(b => Number(formatWei(b.strk, 8)));

    const ctx = document.getElementById('chart-balances');
    if (balancesChart) balancesChart.destroy();
    balancesChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [
                { label: 'ETH', data: eth, borderColor: '#5b8cff', backgroundColor: 'transparent', yAxisID: 'yEth', tension: 0.25, pointRadius: 0 },
                { label: 'STRK', data: strk, borderColor: '#33c17a', backgroundColor: 'transparent', yAxisID: 'yStrk', tension: 0.25, pointRadius: 0 }
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
            plugins: { legend: { labels: { color: '#e6e9ef' } } }
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
        tr.innerHTML = `
            <td>${formatDate(t.timestamp)}</td>
            <td>${direction}</td>
            <td>${formatWei(t.sellAmount, 6)}</td>
            <td>${formatWei(t.buyAmount, 6)}</td>
            <td>${t.actualFees ? formatWei(t.actualFees, 6) : '-'}</td>
            <td>${t.matched ? '✅' : '—'}</td>
            <td>${netCell}</td>
        `;
        body.appendChild(tr);
    }
}

function render(data) {
    renderCurrent(data.current);
    renderBalancesChart(data.balances || []);
    renderDailyChart(data.dailyMatched || []);
    renderTrades(data.trades || []);
}

async function tryLoad(password) {
    const data = await fetchData(password);
    render(data);
    showDashboard();
}

async function init() {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
        try {
            await tryLoad(stored);
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
    } catch (err) {
        showLogin('Wrong password, try again.');
    }
});

init();
