<?php
// Required first by public/index.php, every tools/*.php and the tests (R36).
// Loads the config, sets the time zone and umask, registers the class autoloader.
//
// Class files: one class per file, src/<ClassName>.php, autoloaded on first use.
// Exceptions: src/Http.php (ApiError, Request, Response, Http) and src/Store.php (Store, Tx),
// which are loaded here.

$config = require __DIR__ . '/config.php';

date_default_timezone_set($config['tz']);
umask(0027);

require_once __DIR__ . '/src/Http.php';
require_once __DIR__ . '/src/Store.php';

spl_autoload_register(static function (string $class): void {
    $file = __DIR__ . '/src/' . $class . '.php';
    if (is_file($file)) {
        require_once $file;
    }
});

// Warnings and notices become exceptions, so they can never leak into a JSON response
// or pass silently. Deprecations are only logged.
set_error_handler(static function (int $severity, string $message, string $file = '', int $line = 0): bool {
    if (!(error_reporting() & $severity)) {
        return false;
    }
    if ($severity === E_DEPRECATED || $severity === E_USER_DEPRECATED) {
        error_log("Deprecated: $message in $file:$line");
        return true;
    }
    throw new ErrorException($message, 0, $severity, $file, $line);
});

return $config;
