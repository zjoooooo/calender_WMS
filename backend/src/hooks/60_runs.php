<?php
// R24: deactivating a driver releases every job that driver holds today (end = released; a run whose
// stops are all resolved is closed with end = finished). Replaces the core's minimal default of the same
// name (src/hooks/50_release_on_deactivate.php), because hook files load in name order.
Hooks::add(Hooks::USER_DEACTIVATED, 'release_jobs', [Runs::class, 'onUserDeactivated']);
