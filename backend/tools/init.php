<?php
// First start from the command line (§11.2, R33, R36): creates the data dir (secret.key, plan.json with
// the seed waste types and holidays, users.json with the admin) and prints the admin password once.
// On a later run it finds the existing data and prints nothing. Takes the same lock as the server.
// Usage: php backend/tools/init.php   (WMS_DATA_DIR=<dir> to use another data folder)
$config = require __DIR__ . '/../bootstrap.php';

$store = new FileStore($config);
$store->setClock(new Clock($config));
$store->onSeed = static function (string $password, string $file): void {
    echo "WMS first start: data folder created.\n";
    echo "  Admin login:  username admin   password $password\n";
    echo "  (also written to $file; change the password at the first login)\n";
};

try {
    $store->transaction(static function (Tx $tx): void {
        $tx->get('plan');
        $tx->get('users');
    });
} catch (ApiError $e) {
    fwrite(STDERR, 'WMS init failed: ' . $e->errorCode . ' ' . json_encode($e->details) . "\n");
    exit(1);
}
exit(0);
