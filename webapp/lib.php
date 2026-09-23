<?php
// small shared helpers for ingest.php / data.php

function load_config(): array {
    $path = __DIR__ . '/config.php';
    if (!file_exists($path)) {
        http_response_code(500);
        echo json_encode(['error' => 'config.php is missing - copy config.sample.php to config.php and fill it in']);
        exit;
    }
    return require $path;
}

function read_json_file(string $path, $default) {
    if (!file_exists($path)) return $default;
    $raw = file_get_contents($path);
    if ($raw === false || $raw === '') return $default;
    $data = json_decode($raw, true);
    return $data === null ? $default : $data;
}

// write via a temp file + rename so readers never see a half-written file
function write_json_file_atomic(string $path, $data): void {
    $dir = dirname($path);
    if (!is_dir($dir)) mkdir($dir, 0755, true);
    $tmp = $path . '.tmp-' . bin2hex(random_bytes(4));
    file_put_contents($tmp, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
    rename($tmp, $path);
}

function fail(int $status, string $message): void {
    http_response_code($status);
    header('Content-Type: application/json');
    echo json_encode(['error' => $message]);
    exit;
}

// --- field validators (data only ever comes from our own trader process, but validate anyway) ---

function is_wei_string($v): bool {
    return is_string($v) && preg_match('/^-?\d{1,40}$/', $v) === 1;
}

function is_date_string($v): bool {
    return is_string($v) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $v) === 1;
}

function is_hash_string($v): bool {
    return is_string($v) && preg_match('/^0x[0-9a-fA-F]{1,64}$/', $v) === 1;
}

function is_timestamp($v): bool {
    return is_int($v) && $v > 0 && $v < 99999999999999;
}

function is_sell_string($v): bool {
    return $v === 'eth' || $v === 'strk';
}

function is_status_string($v): bool {
    return $v === 'open' || $v === 'closed';
}

function is_direction_string($v): bool {
    return $v === 'up' || $v === 'down';
}
