<?php
// receives compact trade/balance updates from the trader (src/webReport.ts / src/generateWebStats.ts)
// and persists them into small, bounded json files. Never recomputes anything - Node is the source
// of truth for all aggregation logic.

require __DIR__ . '/lib.php';
$config = load_config();

header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    fail(405, 'method not allowed');
}

$secret = $_SERVER['HTTP_X_REPORT_SECRET'] ?? '';
if (!hash_equals($config['ingestSecret'], $secret)) {
    fail(401, 'unauthorized');
}

// 2 MB is generous for a one-off historic seed; normal per-trade updates are a few hundred bytes
$raw = file_get_contents('php://input', false, null, 0, 2 * 1024 * 1024);
$body = json_decode($raw ?: '', true);
if (!is_array($body)) {
    fail(400, 'invalid json body');
}

$dataDir = $config['dataDir'];
const MAX_TRADES = 100;
const MAX_BALANCE_POINTS = 5000; // ~13 years of daily points

function validate_trade($t): bool {
    if (!is_array($t)) return false;
    if (!is_hash_string($t['hash'] ?? null)) return false;
    if (!is_timestamp($t['timestamp'] ?? null)) return false;
    if (!is_sell_string($t['sell'] ?? null)) return false;
    if (!is_wei_string($t['sellAmount'] ?? null)) return false;
    if (!is_wei_string($t['buyAmount'] ?? null)) return false;
    if (isset($t['actualFees']) && !is_wei_string($t['actualFees'])) return false;
    if (isset($t['netEth']) && !is_wei_string($t['netEth'])) return false;
    if (!is_status_string($t['status'] ?? null)) return false;
    if (isset($t['fromTimestamp']) && !is_timestamp($t['fromTimestamp'])) return false;
    if (isset($t['toTimestamp']) && !is_timestamp($t['toTimestamp'])) return false;
    if (isset($t['tradeCount']) && !is_int($t['tradeCount'])) return false;
    return true;
}

function validate_balance_point($b): bool {
    return is_array($b) && is_date_string($b['date'] ?? null) && is_wei_string($b['eth'] ?? null) && is_wei_string($b['strk'] ?? null);
}

function validate_current($c): bool {
    return is_array($c) && is_wei_string($c['eth'] ?? null) && is_wei_string($c['strk'] ?? null)
        && is_timestamp($c['timestamp'] ?? null) && is_hash_string($c['hash'] ?? null);
}

function validate_daily_entry($d): bool {
    return is_array($d) && is_date_string($d['date'] ?? null) && is_wei_string($d['netEth'] ?? null) && is_int($d['tradeCount'] ?? null);
}

function validate_turning_point($p): bool {
    return is_array($p) && is_date_string($p['date'] ?? null) && is_direction_string($p['direction'] ?? null)
        && (!isset($p['diffEth']) || is_wei_string($p['diffEth']))
        && (!isset($p['diffStrk']) || is_wei_string($p['diffStrk']));
}

// -----------------------------------------------------------------------
// full replace: used once for the initial historic seed (and re-seeds)
// -----------------------------------------------------------------------
if (isset($body['seed'])) {
    $seed = $body['seed'];
    if (!is_array($seed)) fail(400, 'invalid seed');

    if (!validate_current($seed['current'] ?? null)) fail(400, 'invalid seed.current');
    foreach ($seed['balances'] ?? [] as $b) if (!validate_balance_point($b)) fail(400, 'invalid seed.balances entry');
    foreach ($seed['trades'] ?? [] as $t) if (!validate_trade($t)) fail(400, 'invalid seed.trades entry');
    foreach ($seed['dailyMatched'] ?? [] as $d) if (!validate_daily_entry($d)) fail(400, 'invalid seed.dailyMatched entry');
    foreach ($seed['turningPoints'] ?? [] as $p) if (!validate_turning_point($p)) fail(400, 'invalid seed.turningPoints entry');

    $balances = array_slice($seed['balances'] ?? [], -MAX_BALANCE_POINTS);
    $trades = array_slice($seed['trades'] ?? [], -MAX_TRADES);

    write_json_file_atomic("$dataDir/current.json", $seed['current']);
    write_json_file_atomic("$dataDir/balances.json", $balances);
    write_json_file_atomic("$dataDir/trades.json", $trades);
    write_json_file_atomic("$dataDir/daily_matched.json", $seed['dailyMatched'] ?? []);
    write_json_file_atomic("$dataDir/turning_points.json", $seed['turningPoints'] ?? []);

    echo json_encode(['ok' => true, 'seeded' => true]);
    exit;
}

// -----------------------------------------------------------------------
// incremental per-trade update
// -----------------------------------------------------------------------
if (isset($body['current'])) {
    if (!validate_current($body['current'])) fail(400, 'invalid current');
    write_json_file_atomic("$dataDir/current.json", $body['current']);
}

if (isset($body['balancePoint'])) {
    if (!validate_balance_point($body['balancePoint'])) fail(400, 'invalid balancePoint');
    $balances = read_json_file("$dataDir/balances.json", []);
    $date = $body['balancePoint']['date'];
    $balances = array_values(array_filter($balances, fn($b) => ($b['date'] ?? null) !== $date));
    $balances[] = $body['balancePoint'];
    usort($balances, fn($a, $b) => strcmp($a['date'], $b['date']));
    $balances = array_slice($balances, -MAX_BALANCE_POINTS);
    write_json_file_atomic("$dataDir/balances.json", $balances);
}

if (isset($body['trade'])) {
    if (!validate_trade($body['trade'])) fail(400, 'invalid trade');
    $removeHashes = $body['removeTradeHashes'] ?? [];
    if (!is_array($removeHashes)) fail(400, 'invalid removeTradeHashes');
    $trades = read_json_file("$dataDir/trades.json", []);
    $hash = $body['trade']['hash'];
    $drop = array_merge([$hash], $removeHashes);
    $trades = array_values(array_filter($trades, fn($t) => !in_array($t['hash'] ?? null, $drop, true)));
    $trades[] = $body['trade'];
    usort($trades, fn($a, $b) => $a['timestamp'] <=> $b['timestamp']);
    $trades = array_slice($trades, -MAX_TRADES);
    write_json_file_atomic("$dataDir/trades.json", $trades);
}

if (isset($body['dailyEntry']) && $body['dailyEntry'] !== null) {
    if (!validate_daily_entry($body['dailyEntry'])) fail(400, 'invalid dailyEntry');
    $daily = read_json_file("$dataDir/daily_matched.json", []);
    $date = $body['dailyEntry']['date'];
    $daily = array_values(array_filter($daily, fn($d) => ($d['date'] ?? null) !== $date));
    $daily[] = $body['dailyEntry'];
    usort($daily, fn($a, $b) => strcmp($a['date'], $b['date']));
    write_json_file_atomic("$dataDir/daily_matched.json", $daily);
}

if (isset($body['turningPoints'])) {
    foreach ($body['turningPoints'] as $p) if (!validate_turning_point($p)) fail(400, 'invalid turningPoints entry');
    write_json_file_atomic("$dataDir/turning_points.json", $body['turningPoints']);
}

echo json_encode(['ok' => true]);
