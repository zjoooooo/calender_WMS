<?php
// Master data and settings (§10.7). Entry format: see src/App.php.
$office = ['admin', 'office'];
$admin = ['admin'];
return [
    ['GET', '/api/customers', [Customers::class, 'list'], $office],
    ['POST', '/api/customers', [Customers::class, 'create'], $office],
    ['GET', '/api/customers/{id:\d+}', [Customers::class, 'get'], $office],
    ['PATCH', '/api/customers/{id:\d+}', [Customers::class, 'update'], $office],
    ['POST', '/api/customers/{id:\d+}/archive', [Customers::class, 'archive'], $office],
    ['POST', '/api/customers/{id:\d+}/restore', [Customers::class, 'restore'], $office],

    ['GET', '/api/holidays', [Holidays::class, 'list'], $office],
    ['PUT', '/api/holidays/{date}', [Holidays::class, 'put'], $office],
    ['DELETE', '/api/holidays/{date}', [Holidays::class, 'delete'], $office],

    ['GET', '/api/waste-types', [WasteTypes::class, 'list'], $office],
    ['POST', '/api/waste-types', [WasteTypes::class, 'create'], $admin],
    ['PUT', '/api/waste-types/order', [WasteTypes::class, 'order'], $admin],
    ['PATCH', '/api/waste-types/{code}', [WasteTypes::class, 'update'], $admin],

    ['GET', '/api/trucks', [Settings::class, 'trucks'], $office],
    ['PUT', '/api/trucks', [Settings::class, 'putTrucks'], $office],
    ['GET', '/api/settings', [Settings::class, 'get'], $office],
    ['PATCH', '/api/settings', [Settings::class, 'patch'], $admin],

    ['GET', '/api/users', [Users::class, 'list'], $admin],
    ['POST', '/api/users', [Users::class, 'create'], $admin],
    ['PATCH', '/api/users/{id:\d+}', [Users::class, 'patch'], $admin],
    ['GET', '/api/drivers', [Users::class, 'drivers'], $office],
];
