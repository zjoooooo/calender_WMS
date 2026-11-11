<?php
// Auth, me and meta (§10.2, §10.3). Entry format: see src/App.php.
return [
    ['GET', '/api/health', [Meta::class, 'health'], 'public', ['nolock' => true]],
    ['POST', '/api/login', [Auth::class, 'login'], 'public'],
    ['GET', '/api/me', [Auth::class, 'me'], 'any', ['pwchange' => true]],
    ['PATCH', '/api/me', [Auth::class, 'patchMe'], 'any'],
    ['POST', '/api/me/password', [Auth::class, 'changePassword'], 'any', ['pwchange' => true]],
    ['POST', '/api/me/logout-all', [Auth::class, 'logoutAll'], 'any'],
    ['GET', '/api/meta', [Meta::class, 'get'], 'any'],
];
