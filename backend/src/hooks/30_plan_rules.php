<?php
// Rules that run inside every Ctx::savePlan() (plan, holiday, customer and task writes):
//   10 R9/R19 override cleanup (purge overrides dated before today, delete no-op overrides);
//   20 R26 run invariant (RUN_EXISTS / release_run -> dropped_runs, run.removed).
Hooks::onPlanWrite('r9_cleanup', [Plan::class, 'cleanupOverrides'], 10);
Hooks::onPlanWrite('r26', [Plan::class, 'runInvariant'], 20);
