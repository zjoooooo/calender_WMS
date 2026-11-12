<?php
// Front controller (§11.2). Production: Caddy sends only /api/* here (php_fastcgi) and serves
// public/app itself. Local dev: `php -S 0.0.0.0:8080 -t backend/public/app backend/public/index.php`
// uses this file as the router script, so it also does the static/SPA fallback below.
$config = require __DIR__ . '/../bootstrap.php';
ini_set('display_errors', '0');
ini_set('log_errors', '1');

$path = rawurldecode((string) (parse_url((string) ($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH) ?? '/'));
$isApi = $path === '/api' || str_starts_with($path, '/api/');

if (PHP_SAPI === 'cli-server' && !$isApi) {
    // Static files and SPA fallback, for the local php -S server only.
    $appDir = realpath($config['app_dir']);
    if ($appDir !== false && $path !== '/') {
        $file = realpath($appDir . $path);
        if ($file !== false && is_file($file) && str_starts_with($file, $appDir . DIRECTORY_SEPARATOR)) {
            return false; // php -S serves the existing file from its docroot (backend/public/app)
        }
    }
    foreach (Http::SECURITY_HEADERS as $k => $v) {
        header("$k: $v");
    }
    if (str_starts_with($path, '/assets/')) {
        http_response_code(404); // a missing build chunk is a 404, never index.html
        header('Content-Type: text/plain; charset=utf-8');
        echo "Not found\n";
        return true;
    }
    if ($appDir !== false && is_file($appDir . '/index.html')) {
        header('Content-Type: text/html; charset=utf-8');
        header('Cache-Control: no-cache');
        readfile($appDir . '/index.html');
        return true;
    }
    http_response_code(404);
    header('Content-Type: text/plain; charset=utf-8');
    echo "The frontend is not built yet. Run build.bat, or use start-frontend.bat and open port 5173.\n";
    return true;
}

App::create($config)->run();
