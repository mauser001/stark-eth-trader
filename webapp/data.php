<?php
// serves the combined dashboard data set, gated behind the viewer password.
// the json files themselves are not reachable directly (see data/.htaccess).

require __DIR__ . '/lib.php';
$config = load_config();

header('Content-Type: application/json');

$password = $_SERVER['HTTP_X_VIEWER_PASSWORD'] ?? '';
if (!hash_equals($config['viewerPassword'], $password)) {
    fail(401, 'unauthorized');
}

$dataDir = $config['dataDir'];

echo json_encode([
    'current' => read_json_file("$dataDir/current.json", null),
    'balances' => read_json_file("$dataDir/balances.json", []),
    'trades' => read_json_file("$dataDir/trades.json", []),
    'dailyMatched' => read_json_file("$dataDir/daily_matched.json", []),
    'turningPoints' => read_json_file("$dataDir/turning_points.json", []),
]);
