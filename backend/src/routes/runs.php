<?php
// Runs (office), driver API and files (§10.8, §10.9, §10.10). Entry format: see src/App.php.
// {date} is checked by Ctx::dateParam (422 VALIDATION); a job is r<route_id> or t<task_id>.
$office = ['admin', 'office'];
$driver = ['driver'];
$run = '/{date}/{job:[rt][1-9][0-9]*}';
return [
    ['GET', '/api/runs' . $run, [Runs::class, 'get'], $office],
    ['POST', '/api/runs' . $run . '/release', [Runs::class, 'officeRelease'], $office],
    ['POST', '/api/runs' . $run . '/assign', [Runs::class, 'assign'], $office],
    ['PUT', '/api/runs' . $run . '/stops/{cid:[0-9]+}', [Visits::class, 'officeWrite'], $office],

    ['GET', '/api/driver/today', [Runs::class, 'driverToday'], $driver],
    ['GET', '/api/driver/runs' . $run, [Runs::class, 'driverGet'], $driver],
    ['POST', '/api/driver/runs' . $run . '/claim', [Runs::class, 'claim'], $driver],
    ['PUT', '/api/driver/runs' . $run . '/stops/{cid:[0-9]+}', [Visits::class, 'driverWrite'], $driver],
    ['POST', '/api/driver/runs' . $run . '/release', [Runs::class, 'driverRelease'], $driver],

    // R35: the body is read before the lock; the handlers run outside it (blob I/O).
    ['PUT', '/api/files/{name}', [Files::class, 'put'], 'any', ['raw' => true, 'unlocked' => true]],
    ['GET', '/api/files/{name}', [Files::class, 'get'], 'any', ['unlocked' => true]],
];
