<?php
// Calendar and routes (§10.4, §10.5). Entry format: see src/App.php.
$office = ['admin', 'office'];
return [
    ['GET', '/api/calendar', [Calendar::class, 'get'], $office],

    ['GET', '/api/routes', [Plan::class, 'listRoutes'], $office],
    ['POST', '/api/routes', [Plan::class, 'createRoute'], $office],
    ['GET', '/api/routes/suggest-code', [Plan::class, 'suggestCode'], $office],
    ['GET', '/api/routes/{id:\d+}', [Plan::class, 'getRoute'], $office],
    ['PATCH', '/api/routes/{id:\d+}', [Plan::class, 'patchRoute'], $office],
    ['DELETE', '/api/routes/{id:\d+}', [Plan::class, 'deleteRoute'], $office],
    ['POST', '/api/routes/{id:\d+}/change-schedule', [Plan::class, 'changeSchedule'], $office],
    ['PUT', '/api/routes/{id:\d+}/dates/{date}', [Plan::class, 'putRouteDate'], $office],
    ['DELETE', '/api/routes/{id:\d+}/dates/{date}', [Plan::class, 'resetRouteDate'], $office],
    ['POST', '/api/routes/{id:\d+}/dates/{date}/copy', [Plan::class, 'copyRouteDate'], $office],
];
