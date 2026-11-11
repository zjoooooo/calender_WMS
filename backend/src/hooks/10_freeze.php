<?php
// R13: at the start of every locked request (order 10, before the R16 seed import at 20):
// 503 CLOCK_BEHIND_FREEZE when plan.frozen_through >= today, otherwise freeze every day up to today - 1.
Hooks::beforeRequest('freeze', [Schedule::class, 'freezeHook'], 10);
