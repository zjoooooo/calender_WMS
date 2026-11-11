# WMS Route & Task Calendar: v1 Design

- Version: v1 final, 2026-11-11, updated with the Round 4 decisions (Linux VPS hosting, night shifts with a 04:00 day rollover, drag-and-drop stop reordering). Today in every example is Wed 2026-11-11.
- Audience: the developer who builds v1. Read this document instead of the earlier design files.
- User decisions come from `requirements.md`. If this document disagrees with it, `requirements.md` wins.
- §3 lists every rule with an ID (R1 to R36), and later sections refer to those IDs. Error codes are in CAPS, for example `PAST_DATE_LOCKED`.

---

## 1 Goals & scope (v1 / later)

### Goals
1. The office plans **REL collection routes** on a calendar with week and month views. Routes are containers holding an ordered list of customers, and they come in three types: regular, special and adhoc.
2. The office plans **standalone tasks** for the waste types that never go on a route. OTC tasks are one-off only. COMPACTOR tasks are one-off or recurring weekly. Tasks may fall on any day, including Sundays and public holidays.
3. Drivers use a phone web app. They claim today's routes and tasks themselves (the first to confirm gets the job) and record a result for each customer: a weight per waste type, an optional photo, an optional signature, a weighbridge ticket when the type needs one, and a note, or "not collected" with a reason.
4. The office sees driver progress live on the calendar and can correct any result. Every correction is kept in an audit history.
5. Production runs on a **Linux cloud VPS** (Ubuntu 24.04 LTS): Caddy with automatic HTTPS in front of PHP 8.3-FPM, a JSON data folder, systemd starting everything at boot, and a nightly backup. One script, `deploy/install.sh`, sets the server up. Phones and office PCs reach it over HTTPS from the internet. Development and trials run on the user's Windows PC, started by .bat files (PHP built-in server + Vite on 0.0.0.0 ports).
6. Night shifts are supported: the working day rolls over at a configurable hour (default 04:00), so work done after midnight still belongs to the previous day (R1).

### In v1
- Calendar: week view with one-line route rows and month view with route-code chips. Routes are identified by a code, a colour bar and a type tag. Clicking a code highlights that route, and search matches a code or a customer name. Tasks appear separately from route containers.
- Route editing: add, edit and delete route containers; add, remove and reorder customers (drag and drop with mouse or touch, plus ↑ ↓ buttons and "move to #"). A change can apply to "only this date" or to "this date and the following ones". Other route actions: skip a date, copy to another date (to run on a PH or move to a work day), change the schedule, and urgent pickup.
- Tasks: OTC one-off tasks; COMPACTOR one-off and recurring tasks; skipping or moving a single date.
- Master data pages: customers (each registers its waste types), waste types (configurable), holidays (Singapore 2026–2027 prefilled, maintained by users), trucks (the vehicle list drivers pick from) and users.
- Settings: the day rollover hour for night shifts (default 04:00, admin only).
- Logins: office users and drivers both sign in with a username and password. Each user switches the UI language between Chinese and English.
- Driver app: claim, switch route midway, give back, record results, correct own results, and an offline outbox with idempotent retries.
- Office run actions: release a job, assign a driver, close out, back-fill a result, and correct a result with a reason.
- Daily totals per waste type, shown in the calendar.

### Later (details in §16)
Reports and CSV/Excel export (the first v2 item), billing, per-customer rules that make a photo or signature required, office assignment of trucks ahead of time, route optimisation and GPS tracking, a SQLite or MySQL store, and push notifications.

### Sizing assumptions (these drive the simple choices)
- Up to about 25 drivers and 5 office users.
- 10 to 25 routes a day, each with about 5 to 40 stops.
- Up to about 20 tasks a day.
- Up to about 3,000 customers.
- One time zone (Singapore). Night shifts end before the rollover hour (default 04:00), and morning shifts start at or after it. The admin sets the rollover between the end of the latest night shift and the start of the earliest morning shift, because the jobs of day D cannot be claimed before D at that hour.

---

## 2 Glossary

| Term | Meaning |
|---|---|
| Waste type | A configurable kind of waste: `{code, name, abbr, unit, weigh_method, routable, recurring_tasks, confirm_over, active}`. The seed types are REL, OTC and COMPACTOR (R3). |
| Routable type | A waste type with `routable = true` (REL in the seed). Only routable types are collected on routes. |
| Non-routable type | A waste type with `routable = false` (OTC and COMPACTOR). These are collected only through tasks. |
| Customer | A collection point. It registers the waste types it has (`waste_types`). A **routable customer** has at least one active routable type. |
| Route | A planned container of customers, ordered in visit order. It has a type (regular, special or adhoc), a **code** (for example `N1`), a colour and a name. |
| Recurring route | A route with `start`/`end` plus weekdays (regular) or Sunday/PH flags (special). |
| One-off route | A route with a single `date`: an adhoc on a work day, a special on a rest day, or a regular copy on a work day (made only by Copy to date, R15). |
| Template | A recurring route's own stop list. It is the same list every day the route runs. |
| Override | A per-date change to a recurring route (`cancelled`, `stops`, `note`) or to a recurring task (`cancelled`, `note`). |
| Occurrence | A route or task on one date, as computed for the calendar. |
| Effective stops | The customer list of a route occurrence after the override has been applied and inactive or non-routable customers have been dropped (R8). |
| Task | A standalone job for exactly ONE customer and ONE non-routable waste type. It is either one-off (`date`) or recurring (`start`, `end`, `days`). It never goes inside a route. |
| Job | A runnable occurrence: a route job with key `r<route_id>@<date>`, or a task job with key `t<task_id>@<date>`. |
| Run | The execution record of one job. It is created at the first claim, assign, office entry or office close-out, and holds the holder, the holds log and the visits. It is never deleted (R21). |
| Hold | One driver's period of holding a run: `{driver_id, vehicle_no, by, from, to, end}`. |
| Holder | The driver who currently holds a run (`run.driver_id` on a run dated today, R25). On a past run, `driver_id` is only the last holder, shown in history; it does not count as holding. |
| Visit | The result for one customer within one run: collected with weights, missed with a reason, or undone. |
| Rollover hour | The hour at which one working day ends and the next begins (`settings.rollover_hour`, default 4 = 04:00, admin setting). It lets night shifts after midnight count for the previous day (R1). |
| Operational date (op_date) | The working day a moment belongs to: `op_date(now)` = the calendar date of (now − rollover hours) in Asia/Singapore. Every "today" in this document is `op_date(now)` (R1). |
| Day class | `work` or `rest`. Rest = a Sunday or a public holiday (R2). |
| PH | A public holiday from the user-maintained holiday list. |
| Frozen plan | The plan of a past date, written once into `days/<date>.json` so that the past never changes (R13). |
| Past lock | Plan dates before today (the op_date) cannot be written (R11). Results (visits) are not locked. |
| Outbox | The phone's persistent queue of unsent result writes and photos (IndexedDB). |
| op_id | A UUID that the client generates for each result write. A server that sees the same op_id twice applies it once (R30). |
| Roles | `admin` (an office user who can also manage users, waste types and the rollover hour), `office`, `driver`. |

---

## 3 Business rules

### Time and day class

**R1 TIME AND THE OPERATIONAL DAY.**
- There is one time zone, Asia/Singapore (`config.tz`). "today" and "now" are always the server's values.
- **Night shifts exist**, so a working day does not end at midnight. It ends at the **rollover hour** `H` = `plan.settings.rollover_hour`: a whole hour from 0 to 6, default 4 (04:00), changed by an admin in Settings.
- **Operational date**: `op_date(now)` = the calendar date of (now − H hours) in Asia/Singapore.
  - Example with H = 4: Thu 12 Nov 03:59:59 → op_date Wed 11 Nov; Thu 12 Nov 04:00:00 → op_date Thu 12 Nov.
  - The operational day D runs from `day_start(D)` = D at H:00 to `day_end(D)` = (D + 1) at H:00, both +08:00.
  - With H = 0 the rule is plain midnight.
- **Every "today" in this document means `op_date(now)`**, and "yesterday" or "today − 1" means op_date − 1. That covers: the driver's Today list and claims (R23), the holding rule (R25), run statuses (R22), the `LATE` flag and the edit deadline (R28), the past lock (R11), the day freeze (R13), generation from today on (R7, R18), `next_work_day`, and the calendar's Today marker. "Rollover" replaces "midnight" everywhere: the moment op_date changes.
- Timestamps (`from`, `to`, `captured_at`, `received_at`, `at`) stay real clock times. A hold or a visit at 02:30 on Thu 12 Nov on a Wed 11 Nov job is normal for a night shift. Day files, totals and reports use the job's date, never the timestamp's calendar date.
- **Changing H** is refused with 422 `ROLLOVER_SHIFTS_TODAY` {today, would_be, retry_after} when it would change the current op_date (forward or back), so a frozen day can never become today again. That happens only while the clock hour is in [min(old, new), max(old, new)); `retry_after` is max(old, new):00 on the current calendar date. Any change is therefore accepted from 06:00 to 23:59. It takes effect at once for the next rollover and the edit deadline (R28).
- The client never derives today, a weekday, a day class, a lock state or the rollover from its own clock. It reads them from `/api/meta` (`today`, `rollover_hour`, `day_ends_at`) and from the payloads.
- Formats:
  - dates: `YYYY-MM-DD`;
  - weekdays: ISO numbers, 1 = Monday to 7 = Sunday;
  - timestamps: ISO 8601 with `+08:00`.
- `config.fake_now` overrides "now" for tests and demos. op_date is always computed from it, so `fake_now = 2026-11-12T03:59:00+08:00` still means today = 2026-11-11.
  - `Clock` honours `fake_now` only when the data dir contains a `.demo` marker file; the test runners create one in their temp dirs. Otherwise `fake_now` is ignored and a warning goes to the PHP error log, so live data always runs on the real clock. `fake_now` is set in the untracked `config.local.php` (§11.2).
  - A fake_now demo always runs on a **copy** of a data folder, never on the live `/opt/wms/backend/data`. Moving time forward freezes days (R13) and purges overrides (R9), and a later real clock cannot undo that. Each demo that moves time backwards starts from a fresh copy (R13 `CLOCK_BEHIND_FREEZE`).
- One helper, `Clock` (§11.2), computes now, op_date, `day_start` and `day_end`. No other code reads the system clock or compares calendar dates of timestamps.
- `Clock::now()` is read **exactly once per request, after the lock is acquired** (R36). That `now`, and `today = op_date(now)`, are used for the R13 freeze, R11, R22–R28 and the `today`/`now` in the response. A request that waited for the lock across a rollover therefore sees the new day, after the freeze.

**R2 DAY CLASS.** `class(d) = 'rest'` if weekday(d) = 7 or d is in the holiday list. Otherwise it is `'work'`. Only the server computes it.

### Waste types and customers

**R3 WASTE TYPES.**
- Waste types form a configurable list. Array order is display order.
- Fields:
  - `code`: matches `^[A-Z0-9_]{1,10}$`, is unique, and can never change.
  - `name`: 1–30 characters.
  - `abbr`: matches `^[A-Z0-9]{1,10}$`. It is used on chips. The seed uses the code itself (the user named the types REL, OTC and COMPACTOR).
  - `unit`: 1–6 characters, default `kg`. It can never change.
  - `weigh_method`: `on_site` or `weighbridge`.
  - `routable`: a boolean that can never change.
  - `recurring_tasks`: a boolean. It only matters when `routable = false`.
  - `confirm_over`: a number or null. A weight at or above it asks the person for confirmation.
  - `active`.
- Seed, created on first start. Every seed type has `unit = kg` and `weigh_method = on_site`.

  | code | abbr | routable | recurring_tasks | confirm_over |
  |---|---|---|---|---|
  | REL | REL | true | false | 1000 |
  | OTC | OTC | false | false | 1000 |
  | COMPACTOR | COMPACTOR | false | true | null |

- Changing `weigh_method`, `recurring_tasks` or `confirm_over` affects only writes made after the change.
- `code`, `unit` and `routable` never change, because history, routes and tasks depend on them. To change one of them, create a new type.
- Types are never hard-deleted, only deactivated.
- Deactivation is refused with 409 `WASTE_TYPE_IN_USE` {routes | tasks} in these cases:
  - a routable type, while any customer that has it is on a stop list dated on or after today;
  - a non-routable type, while any task of that type generates a date on or after today.
- An inactive type is hidden from forms and refused in new weights. It stays on customers and in history.

**R4 CUSTOMERS.**
- Fields:
  - `code`: unique. When left blank it is generated as `C` + 4 digits.
  - `name`: required.
  - `address`, `phone`, `note`.
  - `waste_types`: a non-empty list of existing codes (otherwise 422 `WASTE_TYPES_REQUIRED` or `UNKNOWN_WASTE_TYPE`). A newly added code must be active; a code already on the customer is accepted even when it is inactive, so a resent full list never fails. The form shows such codes as greyed chips that can still be removed. It is stored in waste-type order.
  - `active`.
- A customer is **routable** when its `waste_types` contains at least one active routable type.
- Master edits are global and take effect at once. Visits keep their own snapshot of the customer.
- Removing a type that is in use is refused with 409 `CUSTOMER_IN_USE` {routes, tasks}. "In use" means either of these:
  - the last routable type, while the customer is on a stop list dated on or after today;
  - a type that one of the customer's tasks uses, while that task generates a date on or after today.
- The refusal does not apply when the request carries `detach: true`. Detach does all of the following in the same transaction:
  - removes the customer from route templates, from overrides dated on or after today and from one-off routes dated on or after today (only if no routable type remains);
  - ends the customer's recurring tasks of the removed types with `end = today − 1` (a series that starts on or after today is deleted);
  - deletes the customer's one-off tasks of those types dated on or after today;
  - returns the list of what it removed.
- R26 applies to a detach.
- Archive = detach every type, then set `active = false`.
- Restore sets only `active = true`. Nothing is added back to any route or task.
- There is no hard delete in v1.

### Routes

**R5 ROUTE IDENTITY (code, colour, tag, order).**
- **Code.**
  - It is required. The server trims it, upper-cases it, and checks it against `^[A-Z0-9][A-Z0-9-]{0,7}$`.
  - Two routes may share a code only if their periods do not overlap. The period is `[date, date]` for a one-off and `[start, end or open]` for a recurring route. An overlap returns 422 `CODE_IN_USE` {route}.
  - As a result, on any date a code names exactly one route, and a schedule split (R14) keeps its code.
  - The check runs on create and on every change to code, date, start or end.
- **Suggested codes.** The office can edit them.
  - New adhoc: `A<n>`.
  - New one-off special: `S<n>`.
  - In both cases n is the smallest integer ≥ 1 that is free on that date.
  - Copy to date: `<first 5 chars of the source code>-<DD of the target>`, for example `N1-25`.
  - Recurring routes get no suggestion; the office types the code.
- **Colour.**
  - It is an integer from 1 to 10, an index into the fixed palette (§9.1).
  - On create, the server picks the index used by the fewest routes whose period reaches today or later. Ties go to the lowest index.
  - Copies and schedule splits inherit the colour.
  - It is editable, and repeats are allowed. The colour is a secondary cue; the code is the identifier.
- **Type tag.**
  - `R` = regular, `S` = special, lightning + `A` = adhoc.
  - Adhoc containers also have a dashed amber border.
- **Order within a day.** Adhoc routes come first. All other routes follow, sorted by code in natural order, so N2 comes before N10.

**R6 ROUTE TYPES.**
- A route's type can never change (422 `TYPE_IMMUTABLE`).
- A route with `date` is a one-off. Any other route is recurring, with `start` (required) and `end` (nullable).
- **regular**: recurring, with `days` a non-empty, de-duplicated, sorted subset of 1..6. Otherwise 422 `WEEKDAY_NOT_ALLOWED`. A regular one-off (a `date` on a work day, with `copied_from` set) exists only as the result of Copy to date (R15), for example a PH-paused route moved to another work day. It keeps the R tag and a solid border, because it is not an emergency.
- **special**: either recurring with `sun` and/or `ph` true, or a one-off whose date is a rest day.
- **adhoc**: a one-off whose date is a work day. It is therefore never on a Sunday or a PH.
- Any other combination returns 422 `DAY_CLASS_VIOLATION`.
- A change to a one-off's date is checked against this rule again.

**R7 ROUTE GENERATION.** Generation is defined for any date d > `plan.frozen_through` with start ≤ d ≤ (end or open). The calendar uses it live for d ≥ today, and R13 uses it once to snapshot the dates it freezes. Dates ≤ `frozen_through` come only from their frozen plan.
- **regular**: generates d when weekday(d) is in `days`.
  - If d is a holiday, the status is `holiday_skipped`. Regular routes **pause automatically on a Monday–Saturday PH**, and the office can move or run them through R15.
  - Otherwise the status is `scheduled`.
- **recurring special**: generates d when (`sun` and weekday(d) = 7) or (`ph` and d is a holiday). It generates at most once per date.
- **one-off**: generates exactly its own date.
- An override with `cancelled = true` sets the status to `cancelled`.
- Only `scheduled` occurrences can be run.

**R8 EFFECTIVE STOPS** for (route, d):
- `override(d).stops ?? route.stops`.
- Drop customers that are inactive or no longer routable.
- Array order is visit order, and `seq` is the position, counted from 1.

**R9 ROUTE OVERRIDES.**
- Overrides exist only for recurring routes, with at most one per (route_id, date).
- The date must be ≥ today and must be one the route generates (otherwise 422 `NOT_AN_OCCURRENCE`).
- Fields:
  - `cancelled`;
  - `stops`: null means inherit from the template; otherwise a full list;
  - `note`.
- After every write, an override is deleted when it is not cancelled, its note is empty, and its stops are null or equal to the template's effective list. The "edited" badge therefore never lies.
- Overrides on dates the route no longer generates are kept but ignored.
- Overrides dated before today are purged on the next write.

**R10 STOP LISTS.**
- Every customer on a stop list must exist, be active (422 `CUSTOMER_INACTIVE`) and be **routable** (422 `CUSTOMER_NOT_ROUTABLE`).
- A customer appears at most once in any stop list (422 `DUPLICATE_STOP`).
- An empty list is legal and returns the warning `EMPTY_ROUTE`.
- The same customer may be on several routes on one date. The picker labels such a customer "also on N2".

**R11 PAST LOCK (plan only).**
- These dates must be ≥ today when a plan write sets them:
  - route start, one-off date and override date;
  - copy target;
  - holiday date;
  - task date or start, and task override date.
- `end` must be ≥ today − 1.
- Otherwise the write returns 422 `PAST_DATE_LOCKED`.
- The check applies to creates and to a field whose value changes. An edit form that resends an unchanged past `start`, `date` or `end` (for example a rename of a route that started on 2 Nov) is accepted.
- "today" is the op_date (R1): at 02:30 on Thu 12 Nov, Wed 11 Nov is still today and its plan can still be edited for the night shift. It locks at 04:00.
- Template edits are always allowed and affect only today onward, because past days are frozen (R13).
- The past lock never applies to visits (R28, R29).

**R12 SAVE SCOPE** for a recurring container on date D.
- **Only this date** writes `override(D).stops` and its note.
- **This date and following** makes the on-screen list the route's list from D onward:
  - If D is the first date ≥ today that the route generates, the template `stops` are replaced by the on-screen list.
  - Otherwise the save runs R14 with `from = D` and the on-screen list as the new route's `stops` (the schedule fields stay the same). The old route keeps its list until D − 1.
  - In both cases `override(D).stops` is cleared. The occurrence note is written to `override(D).note`, because it belongs to one date (R9 cleanup removes it when it is empty). `route.note` changes only through Edit route.
- Later dates that have their own list are not changed, and the dialog names them.
- One-off routes save directly, with no scope question.

**R13 DAY FREEZE.**
- At the start of every request, under the lock, the server first checks that the clock has not gone back: if `plan.frozen_through` ≥ today (a server clock stepped back past a rollover, or a demo's `fake_now` was removed), the request returns 503 `CLOCK_BEHIND_FREEZE` {frozen_through, today} and writes nothing. A frozen day can never become today again.
- It then checks whether `plan.frozen_through` < today − 1.
- If so, it writes `days/<d>.json.plan` from the current plan for every d from `frozen_through + 1` to today − 1. The plan includes routes, tasks and their statuses (cancelled and holiday_skipped ones too).
- It then sets `frozen_through = today − 1`.
- Dates before today are rendered only from their frozen plan plus their runs. Today and later dates are computed live.
- A date ends at its rollover (R1), not at midnight: Wed 11 Nov is frozen by the first request at or after Thu 12 Nov 04:00 (default H), never at 00:00.
- No write can change a date after that date has ended without first freezing it.

**R14 CHANGE SCHEDULE FROM D** (D > today) is one transaction that does four things:
- sets `end = D − 1` on the route;
- creates a copy of the route (new id; same code and colour; the `stops` sent with the request, or else the same stops) with `start = D` and the new `days` or `sun`/`ph` (or the old ones when none are sent);
- moves overrides dated ≥ D to the new route;
- re-points `copied_from.route_id` to the new id on every one-off route whose `copied_from` = {old id, date ≥ D}, so "covered by" labels stay correct.

Edits to `days`, `sun`, `ph`, `start`, `end`, `name`, `note`, `code` and `color` made without "from D" change the template at once, so they apply from today onward.

**R15 COPY TO DATE (routes)**: `POST /routes/{id}/dates/{src}/copy`.
- **Source.** The source date may be any date. A past date is read from its frozen plan.
- **Target.** The target T must be ≥ today.
- **What is created.**
  - Stops: the source's effective stops, minus customers that are now inactive or not routable.
  - Type: if class(T) = rest, `special` (a one-off). If class(T) = work, `adhoc` when the source is adhoc, otherwise `regular` (a one-off, R6). Adhoc stays reserved for emergencies (Urgent pickup, "+ Route ⚡ Adhoc").
  - Code suggested per R5, the source's colour, and the name `<name> (from <src as "Fri 25 Dec">)`.
  - `copied_from = {route_id, date: src}`.
- **skip_source.** `skip_source = true` cancels the source date in the same transaction. It is allowed only when src ≥ today and src is a scheduled date of a recurring route. When src = today, the body may carry `release_run` (R26).
- **What it covers.**
  - "Run on PH": copy a holiday_skipped date to the same date, which creates a special one-off.
  - "Move to work day": copy to a work date, which creates a regular one-off (R tag, solid border).
  - Rescheduling.
  - Re-planning yesterday's leftovers.
- **Calendar.** Every source occurrence with a copy shows "covered by `<code>` `<date>`" (`covered_by`, §4.8).

**R16 HOLIDAYS.**
- The holiday list is `{date, name}`, with one entry per date.
- Seed: Singapore 2026 (§4.6) and Singapore 2027. The 2027 dates are copied from the official MOM list at build time (M2) and confirmed by the user.
- The seed is imported per year. The check runs at the start of every request together with the R13 freeze, because neither PHP-FPM nor `php -S` has an app start-up step: every year in `seed/holidays-sg.json` that is not in `plan.seeded_years` is imported, skipping dates already present or under a stored adhoc or regular one-off, and the year is then added to `seeded_years`. A year added to the seed file later (2027 in M2) therefore reaches an existing data directory, and holidays the user deleted are never re-added.
  - This later import runs after the R13 freeze in the same request and adds only dates > today. Seed dates on today or earlier are skipped and listed in the audit log, so an import never changes today's runs (R26) or a past day. The first-start seed (§4.2) imports every seed year in full, because there is no past or run yet.
- Add, rename and delete are allowed only for dates ≥ today. Past dates return `PAST_DATE_LOCKED`.
- A holiday write is refused with 409 `HOLIDAY_CONFLICT` {routes} if a stored one-off route would become illegal. That happens in two cases:
  - adding a holiday on the date of an adhoc or a regular one-off;
  - removing a non-Sunday holiday from under a special one-off.
- Recurring routes simply recompute.
- **Holidays never affect tasks.**
- A holiday write that affects today is also subject to R26.
- The calendar returns `missing_holiday_years`: every year in the visible range, or within the next 60 days, that has no holidays. The UI shows a banner for them.

### Tasks (OTC, COMPACTOR)

**R17 TASKS.**
- A task is a standalone job for **one** customer and **one** non-routable waste type. It is never inside a route container.
- Validation:
  - `waste_type` must be active and non-routable (422 `TYPE_ROUTABLE`).
  - The customer must be active (422 `CUSTOMER_INACTIVE`) and registered for that waste type (422 `CUSTOMER_LACKS_TYPE`).
- Shape:
  - one-off: `{date}`;
  - recurring: `{start, end|null, days}`, where `days` is a non-empty, sorted subset of **1..7** (Sunday is allowed).
- A recurring task is allowed only when `waste_type.recurring_tasks = true` (422 `RECURRING_NOT_ALLOWED`). With the seed types, OTC is one-off only and COMPACTOR can be one-off or recurring.
- Day rules:
  - **R6/R7 do not apply.** A task may fall on any day: a work day, a Sunday or a PH.
  - The regular/special/adhoc day rules do not apply.
- What can change:
  - `waste_type`, `customer_id` and the kind (one-off or recurring) never change (422 `TASK_FIELD_IMMUTABLE`). To change one, create a new task.
  - `note`, `date` (one-off) and `days`/`start`/`end` (recurring) are editable, subject to R11. Edits apply from today onward.
- Delete removes the task and its overrides. Past days stay as they are, because they are frozen.

**R18 TASK GENERATION.** Like R7, it is defined for any date d > `plan.frozen_through`: live for d ≥ today, and once for the dates R13 freezes.
- A one-off task generates its own date.
- A recurring task generates d when start ≤ d ≤ (end or open) and weekday(d) is in `days`. **This includes public holidays** (the user confirmed that recurring COMPACTOR tasks run on PH). To leave out a PH, the office skips that single date.
- An override with `cancelled = true` sets the status to `cancelled`. Otherwise the status is `scheduled`.

**R19 TASK OVERRIDES.**
- They exist only for recurring tasks, with at most one per (task_id, date).
- The date must be ≥ today and must be one the task generates (otherwise `NOT_AN_OCCURRENCE`).
- Fields: `cancelled` and `note`. An override that is not cancelled and has an empty note is deleted.
- **Move one date** = `POST /tasks/{id}/dates/{src}/copy {to, skip_source:true}`. In one transaction it creates a one-off task on T ≥ today (same customer, type and note; `copied_from = {task_id, date}`) and cancels the source date. When src = today, the body may carry `release_run` (R26). The cancelled source row shows "→ Sat 21 Nov" (`covered_by`, §4.8).
- Copying from a past date without skip_source is allowed, for example to re-plan a task that was missed.

**R20 OFFICE CONCURRENCY.**
- Routes and tasks each carry a `rev`. Every write to the item or to its overrides bumps it, and every such write must send the rev it is based on.
- A mismatch returns 409 `STALE_REVISION` {current}. The UI refetches and keeps the draft on screen.
- Writes to customers, holidays, waste types, trucks and users are last-write-wins.

### Jobs, runs and drivers

**R21 JOBS AND RUNS.**
- A job is a scheduled occurrence. It is either a **route job** (`r5@2026-11-11`) or a **task job** (`t6@2026-11-11`).
- There is at most one run per job. It is stored in `days/<date>.json` under `runs["r5"]` or `runs["t6"]`.
- A run is created only by:
  - a driver claim (R23);
  - an office assign (R24);
  - an office result entry (R29);
  - an office close-out (§6.12) on a job with no run: a holder-less run with every stop missed `not_visited`.
- A run is never deleted. When R26 `release_run` removes its job from the plan, the run is moved to the day's `dropped_runs` with its history.
- A run never copies the plan:
  - A route job's stop list is the occurrence's effective stops: live for today, frozen for past dates.
  - A task job's stop list is `[task.customer_id]`.
- Counts:
  - `pending` = stop-list customers with no collected or missed visit;
  - `resolved` = collected + missed;
  - `total` = pending + resolved.

**R22 RUN STATUS** is derived on every read and never stored.
- A scheduled occurrence with no run, or with a run that has resolved = 0 and either no holder or pending = 0 (for example after a wrong pick was given back):
  - `planned` if its date > today;
  - `not_started` if its date = today;
  - `no_record` if its date < today.
- With a run, checked in this order:
  1. `done` if pending = 0;
  2. else `incomplete` if date < today;
  3. else `active` if `driver_id` is set;
  4. else `open`, shown as "needs driver".
- An occurrence that is cancelled or holiday_skipped and has no run has run status null.

**R23 CLAIM.** Only a driver can claim, the claim needs the network, and it is one locked transaction.
1. The job's date must be today, the op_date (422 `NOT_TODAY`). A night-shift driver at 02:30 on Thu claims Wed's jobs; Thu's jobs become claimable at 04:00.
2. If I already hold it, the result is 200 and `vehicle_no` is updated if one was sent.
3. If another driver holds it, the result is 409 `RUN_TAKEN` {driver, since, collected, total}.
4. Otherwise the job must be scheduled with pending ≥ 1 (422 `NOT_RUNNABLE`, which also covers done jobs).
5. `vehicle_no` is required (422 `VEHICLE_REQUIRED`). It is normalised to upper case without spaces and must be an active plate from the trucks list that the office maintains in Settings (422 `VEHICLE_UNKNOWN`). Drivers pick it; there is no free text. While the list is empty, the plate picker reads "No trucks set up yet: ask the office".
6. Route jobs only: `finishIdleRouteHold(me)` first closes, with `end = finished`, any route job I hold with pending = 0. Then, if I hold another route job with pending > 0, the result is 409 `DRIVER_HAS_ACTIVE_RUN` {job, code, pending}. With `switch = true`, that run is given back first, in the same transaction (R24, `end = switched`).
7. **Task jobs never conflict.** A driver may hold one route job and any number of task jobs at the same time.
8. The claim creates the run if there is none (201), otherwise it reuses the existing one (200), and appends a hold `{driver_id, vehicle_no, by:"self", from}`.

The first claim wins. The client never shows a claim before the server has confirmed it.

**R24 LEAVE / FINISH / RELEASE / ASSIGN.**
- **Leave and finish** are done by the holder, and only while the run's date is today (otherwise 422 `NOT_TODAY`, as for a claim). After the rollover only the office closes out a past run (§6.12). **Release** is done by the office. All three follow one rule:
  1. If `mark_missed = true`, every pending stop first becomes missed with the given reason. The office close-out uses `not_visited`.
  2. Then the holder is cleared and the current hold is closed. The run and its holds are always kept, so a late outbox write from the driver is still accepted (R28, `LATE`):
     - if pending = 0, with `end = finished`;
     - otherwise with `end = left`, `switched` or `released`. The job becomes `open`, or shows as `not_started` again when resolved = 0 (R22). Any driver, including the same one, may pick it up that day.
- Task jobs have no Finish step, because done is derived. "Give back" a task is the same as leave.
- **Assign** (office):
  - The job's date must be today, and the job must be scheduled with pending ≥ 1.
  - If another driver holds the job, that hold ends with `end = reassigned`.
  - The target driver X must be an active driver.
  - For a route job: `finishIdleRouteHold(X)` runs first, as in R23 step 6. Then, if X holds another route job with pending > 0, the result is 409 `DRIVER_HAS_ACTIVE_RUN`. With `switch = true`, X's other route is given back with `end = switched`.
  - Assign appends `{driver_id: X, vehicle_no: null, by: "user:<office id>"}`.
  - The driver app makes X pick a plate before entering results; picking the plate is a claim call that returns 200 because X already holds the job.
- **Deactivating a driver** releases every job that driver holds (`end = released`).

**R25 HOLDING.**
- A driver holds a job when `run.driver_id` = that driver, `run.date` = today and pending > 0.
- A driver holds at most **one route job** and any number of task jobs.
- A route job has at most one driver at a time: two trucks never share a route on the same day (user decision). A big route is split with an "only this date" edit plus an adhoc route.
- Runs from earlier dates are never held: at the rollover (R1, default 04:00, not midnight) they become `incomplete` with no write.

**R26 RUN INVARIANT ON PLAN WRITES.**
- After any plan, holiday, customer (detach or archive) or task write is applied in memory, every run in today's day file must still match a today occurrence whose status is `scheduled`.
- Otherwise the write is refused with 409 `RUN_EXISTS` {runs:[{job, code_or_customer, driver, resolved}]}, and nothing is saved.
- With `release_run = true`, the write goes ahead only if every affected run has resolved = 0. Those runs are moved from `runs` to `dropped_runs` in the same day file (kept with their visit history, never displayed).
- An affected run with no holder and resolved = 0 does not block; it is moved to `dropped_runs` without asking.
- Apart from that, stop-list edits are always allowed.
- In the same pass, whenever a plan, customer-detach or archive write drops a pending customer from a today occurrence that has a run, the customer_id is appended to `run.removed`. A late driver collection for that customer is then still accepted (R28 `OFF_PLAN`).

### Visits (results)

**R27 VISIT CONTENT.**
- There is one visit per (run, customer). `outcome` is `collected`, `missed` or `null` (undone: the stop is pending again).
- **Weighable types:**
  - Route job: exactly the customer's registered, active, routable types. (An `OFF_PLAN` customer that was detached and has none left may be weighed in any active routable type, so an offline collection is never lost.)
  - Task job: exactly the task's waste type.
  - Any other key returns 422 `TYPE_NOT_ALLOWED`. **OTC and COMPACTOR weights can therefore never be entered on a route.** If a customer needs another type, the driver calls the office, which edits the customer.
- **collected:**
  - `weights` is `{code: number}`. Each value is 0–99999.9 with at most 1 decimal; "," is accepted as the decimal separator (422 `WEIGHT_INVALID` otherwise).
  - At least one value must be > 0 (422 `WEIGHT_REQUIRED`). A registered type that is absent counts as 0.
  - `tickets` is `{code: string 1–30}`. A ticket is required for each weighed type with `weigh_method = weighbridge` and weight > 0 (422 `TICKET_REQUIRED`). Tickets are dropped for on_site types.
- **missed:**
  - `reason` is one of `no_waste`, `closed`, `no_access`, `refused`, `other` or `not_visited`.
  - `other` needs a note (422 `REASON_REQUIRED`).
  - `weights` and `tickets` must be empty.
- **Both outcomes:**
  - `photos`: up to `max_photos` (5) file references, optional.
  - `signature`: at most 1 file reference, optional.
  - `note`: up to 500 characters.
  - Every referenced file must already be uploaded (422 `FILE_MISSING`).
- **Stored by the server:** a customer snapshot `{code, name, address}`, `captured_at` (device clock), `received_at` (server clock), `driver_id` and `by`.

**R28 DRIVER RESULT WRITES.**
- The driver must appear in `run.holds` (otherwise 409 `NOT_HOLDER`).
- The customer must belong to the job (otherwise 422 `NOT_ON_JOB`):
  - task job: only `task.customer_id`. This applies to office writes too, because a task has exactly one customer.
  - route job: a customer on the effective stop list, or one that is not on it but is in `run.removed` or already has a visit in this run. Such a write is accepted with the flag `OFF_PLAN`, so a real collection is never refused because the office removed the stop after the driver loaded it. Drivers cannot add other customers on site (requirements: call the office). Office writes on route jobs are not limited by this rule (R29); they may record any routable customer as `OFF_PLAN`.
- A **first** result for a pending stop is accepted at any time. Changing an existing visit (correction or undo) must happen before the **edit deadline** = `day_end(run date)` + `driver_edit_grace_hours` (config, 8 h), i.e. the run's rollover plus 8 hours: 12:00 on run date + 1 with the default 04:00 rollover (otherwise 422 `EDIT_WINDOW_CLOSED`). The driver UI offers corrections only on today's (op_date) jobs; this server window only lets corrections queued before the rollover still arrive.
- The stop must be pending, or its visit must have been written last by this driver (otherwise 409 `VISIT_CHANGED` {visit}).
- **`LATE`.** The write's effective time is `t = captured_at` when `hold.from ≤ captured_at ≤ received_at`, where `hold.from` is the start of this writer's latest hold on the run (server clock); otherwise `t = received_at`. A writer who is not `run.driver_id` (the holder, or for a past run its last holder), or whose `t` ≥ `day_end(run date)`, adds the flag `LATE`.
  - A night-shift stop captured at 03:30 on Thu for a Wed job is not `LATE`, even when the outbox delivers it at 04:05 after the phone regains signal. A stop captured at 04:01 is `LATE`.
  - The bounds keep a wrong phone clock from moving `t` outside the driver's own hold or past the moment the server received the write.

**R29 OFFICE RESULT WRITES AND CORRECTIONS.**
- Office and admin users may write any visit, on any job, on any date (on a task job only for the task's customer, R28 `NOT_ON_JOB`).
- Changing an existing visit requires `why` (422 `WHY_REQUIRED`) and adds the flag `OFFICE_EDITED`.
- A first visit on a scheduled job dated ≤ today that has no run creates a run with no holder. This is a back-fill, for example of a route done on paper. The office may set `driver_id` on such a new visit.
- The office may add or remove photos and the signature.

**R30 VISIT REVISIONS AND IDEMPOTENCY.** Every result write carries `op_id` (a UUID v4) and `base_rev`. The server checks, in this order:
1. If `op_id` is in `visit.ops` (the last 20 ops it processed), this is a **replay**. The server returns the recorded result again (200 with the current visit, or 409 `VISIT_CHANGED`) and changes nothing.
2. If `base_rev` = `visit.rev` (0 when there is no visit yet), the write is applied. `rev` goes up by 1, and the previous values are appended to `history`.
3. If the writer is the same principal as the last write (`user:<id>`), the write is applied. This covers a lost response followed by a new edit.
4. Otherwise the result is 409 `VISIT_CHANGED` {visit}. The rejected body is appended to `history` with `rejected = true`, and the visit gets the flag `CONFLICT`, so no weight is ever lost.

The replay check (step 1) runs before the R28 checks. A retry whose response was lost therefore never turns into `EDIT_WINDOW_CLOSED` or `NOT_HOLDER`.

**R31 SAME CUSTOMER ON TWO JOBS.**
- Each run has its own visit. Visits are never merged and are not unique per date.
- A typical case is customer A on route N1 (REL) and an OTC task for A on the same day.
- The driver app shows "also on `<code or task>` (`<outcome>`)". Day totals include both visits.

**R32 TOTALS.**
- Totals are the sum of weights over collected visits, per waste-type code, rounded to 0.1 on output, in the type's unit.
- A day's totals cover every route job and task job dated that day (its op_date), including collections made after midnight on a night shift.
- Totals are labelled "provisional" while any job of that day is `active` or `open`.

### Accounts, files, storage

**R33 ACCOUNTS AND ROLES.**
- Users live in `users.json` with these fields:
  - `username`: matches `^[a-z0-9._-]{3,30}$`, unique, compared case-insensitively;
  - `name`, `role` (`admin`, `office` or `driver`), `lang` (`zh` or `en`);
  - `password_hash` (from `password_hash()`), `must_change_password`, `active`;
  - `token_version`, `failed_logins` (per-IP counters, R34).
- Passwords are at least 8 characters (422 `PASSWORD_TOO_SHORT`).
- Seed: user `admin` with a random 12-character password generated on first start and `must_change_password = true`. The password is printed by the first start (locally in the `start-backend.bat` console; on the VPS by `deploy/install.sh`, which runs `tools/init.php` as the service user) and written to `data/initial-admin.txt`; that file is deleted after the first password change. There is no fixed default password, because the server faces the internet. Until the password is changed, every call except `GET /api/me` and `POST /api/me/password` returns 403 `PASSWORD_CHANGE_REQUIRED`.
- Roles:
  - `driver`: may call `/api/driver/*`, `/api/meta`, `/api/me*` and `/api/files/*`.
  - `office`: may call every office endpoint except user management, waste-type writes and the rollover setting (`PATCH /api/settings`).
  - `admin`: everything office can do, plus those.
- A token used outside its role returns 403 `FORBIDDEN`.
- The last active admin cannot be deactivated or demoted (422 `LAST_ADMIN`).
- `lang` is stored per user and switched from the header. The login page uses the browser's last choice (localStorage), default `zh`.

**R34 SESSIONS.**
- `POST /api/login {username, password}` returns a token.
- Token format: `base64url(json{uid, tv, exp}) + "." + base64url(HMAC-SHA256(secret.key, payload))`, with `exp` = now + 30 days.
- A token is valid when the signature checks, `exp` > now, the user is active and `tv` = `token_version`.
- A password change, an admin reset, a deactivation and "sign out everywhere" all bump `token_version`.
- Lockout: after 5 wrong passwords for a username from one client IP, that username is locked for that IP for 10 minutes (423 `ACCOUNT_LOCKED` {until}). Keying by IP stops an internet client from locking every driver out at shift start. The IP is `REMOTE_ADDR`. In production Caddy's `php_fastcgi` passes the real client address there; `X-Forwarded-For` is never trusted, because nothing else sits in front of Caddy. The counters live on the user record (`failed_logins: {ip: {n, until}}`, stale entries pruned). An admin "Reset password" also clears them.
- There is no sleep after a failed login (it would tie up a PHP-FPM worker in production and block the single-threaded `php -S` in local dev). An unknown username still runs `password_verify` against a fixed dummy hash, so the response time does not reveal which usernames exist. Token signatures are compared with `hash_equals`.

**R35 FILES (photos, signatures).**
- **Upload.** `PUT /api/files/{uuid}.{jpg|png}` with a raw body.
  - `uuid` is a lowercase UUID v4.
  - A jpg is at most 2 MB and must start with `FF D8 FF`. A png is at most 300 KB and must start with `89 50 4E 47`. Otherwise 422 `FILE_INVALID` or 413 `FILE_TOO_LARGE`.
- **Storage.** The file is stored at `data/files/<first 2 chars of uuid>/<uuid>.<ext>` (temp file + rename). If the file already exists, the result is 200 and the file is not changed, so uploads are idempotent.
- **Outside the lock.** A slow 4G upload or download must never hold the global lock (R36). `index.php` reads the whole request body (at most the limit + 1 byte, so the 413 and 1 MB checks still work) **before** it takes the lock. The file handlers then do auth and the R13 freeze in a short locked section, release the lock, and write the blob (temp file + rename) or stream it outside the lock. That is safe because files are immutable and never part of a JSON transaction.
- **References.** Requests name files as `<uuid>.<ext>`. The server resolves the name and stores the **path** in the visit, for example `files/0b/0b6e…c1.jpg`.
- **Download.** `GET /api/files/{uuid}.{ext}` works for any logged-in user. Because an `<img src>` cannot send the bearer token, the client shows files through `fileUrl(path)` in `api.ts`: it fetches with the token, returns `URL.createObjectURL(blob)` (cached by react-query, revoked on unmount). A token is never put in a URL.
- **Resize before upload.** Photos are resized to at most 1600 px on the long edge, as JPEG at quality 0.7 (about 200–400 KB), by `src/ui/photo.ts`, which both the driver form and the office Result dialog use. A signature is a PNG from a canvas.
- **UUIDs** (file names and `op_id`) come from a small helper over `crypto.getRandomValues`, never `crypto.randomUUID`, which is missing outside a secure context.
- Orphan files are kept (cleanup is deferred).

**R36 STORAGE, SYNC, AUDIT.**
- **Locking.** Every request runs inside one exclusive `flock` on `data/.lock`. It reads only the documents it needs and writes only the ones that changed.
  - The request body is read in full before the lock is taken, and blob I/O (photo upload and download) runs after it is released (R35). The locked section therefore never waits on the network.
  - `flock` behaves the same on Linux (production) and Windows (local dev). In production several PHP-FPM workers run at once; the lock serialises them exactly as before, and `tools/backup.php` and `tools/init.php` take the same lock.
  - FPM workers are long-lived processes, so `FileStore` releases the lock in a `finally` block at the end of every request instead of relying on process exit.
- **Atomic writes.** Each write goes to a temp file in the same directory (`fopen`, `fwrite`, `fflush`, `fsync`, `fclose`), which is then renamed over the original.
  - Linux: `rename(2)` replaces the file atomically, even while another process has it open. `fsync()` (PHP ≥ 8.1) works the same on both systems. A crash right after the rename can at worst leave the previous version, never a torn file.
  - Windows (local dev only): the rename is retried 5 times, 50 ms apart.
  - Paths are built with `/` and `__DIR__`, which work on both systems. File names are lower case, because Linux is case-sensitive.
  - `backend/bootstrap.php` loads the config, calls `date_default_timezone_set(config.tz)` and `umask(0027)`. `index.php` and every `tools/*.php` require it first, so files created from the CLI (`init.php`, `backup.php`) get the same 0640/0750 modes and the same time zone as files created through PHP-FPM.
- **Write order.** Day files first, then `users.json`, then `plan.json`, keeping `*.bak` copies of the plan and users documents. The current file is copied to `.bak` only if it decodes.
- **Corrupt data.** If any existing document fails `json_decode`, the request fails with 503 `DATA_CORRUPT` naming the file, and nothing is written; the operator restores the `.bak`. A missing day file reads as an empty day, but a present, undecodable one fails the same way.
- **First start.** Seeding happens only when `data/plan.json`, `data/plan.json.bak` and `data/days/` are all absent. A missing or corrupt plan is never treated as a first start.
- **Polling.** There are no websockets.
  - The driver app polls every 30 s while it is visible.
  - The office calendar polls every 30 s when its range contains today, and also on window focus.
  - **Rollover**: every polled response carries `today`. When it differs from the client's copy (the rollover has passed), the client refetches `/api/meta`; the calendar moves its Today marker and the driver app reloads its Today list. The client also sets one refetch timer for the duration (`day_ends_at` − `now`) taken from `/api/meta`, so a wrong phone clock does not matter. It never computes the rollover from its own clock.
  - When `today` changes (from a poll or from that timer), the client **invalidates every query** (calendar ranges, routes, tasks, open drawers, the driver's jobs), re-arms the timer from the new `day_ends_at`, and decides whether to poll using the new today. So a calendar range that did not contain the old today (for example next week, viewed on Sunday night) also gets fresh `past`, `can_create`, `ops` and run statuses, and an open drawer drops edit controls that would now fail with `PAST_DATE_LOCKED`.
- **Network.** Claim, switch, give back and assign need the network. Result writes and photos go through the phone outbox.
- **Audit log.** Every successful non-GET request appends one line to `data/audit/YYYY-MM.jsonl`: `{at, user_id, username, method, path, status, body}`. The keys `password`, `old` and `new` are removed from `body` at any depth, and file bytes are never logged.

---

## 4 Data model

### 4.1 Storage decision: JSON files (kept) behind a Store interface
**JSON files** (the user's decision) stay safe with many phones writing at once: every request runs under one exclusive flock with atomic temp-file-and-rename writes, driver writes touch only today's small day file, and photos never enter JSON. At about 25 drivers making roughly one write a minute each, the lock is busy less than 1% of the time; if load ever outgrows that, a `SqliteStore` or `MysqlStore` replaces `FileStore` behind the same interface without touching rule code.

### 4.2 Store interface (PHP)
```php
interface Store {
    /** Runs $fn(Tx $tx) under the global exclusive lock. Documents read through $tx are cached;
     *  documents passed to put() are written atomically (day files, then users, then plan) when $fn returns.
     *  If $fn throws, nothing is written. */
    public function transaction(callable $fn): mixed;
}
interface Tx {
    public function get(string $doc): array;   // 'plan' | 'users' | 'day:2026-11-11' (a missing day returns an empty day)
    public function put(string $doc, array $data): void;
}
final class Blobs {                              // photos and signatures; not part of the transaction
    public function put(string $uuid, string $ext, string $bytes): string; // returns 'files/0b/<uuid>.jpg'; idempotent
    public function exists(string $path): bool;
    public function stream(string $path): void;
}
```
- `FileStore` implements both interfaces.
- On first start (R36: `plan.json`, `plan.json.bak` and `days/` all absent) it creates `data/` with `secret.key` (32 random bytes), `plan.json` (seed waste types and holidays, `settings.rollover_hour = 4`, `frozen_through = today − 1`, `seeded_years`) and `users.json` (the admin user with a random password, R33).
- `get()` throws `DATA_CORRUPT` (503) for any present file that does not decode (R36).
- If `secret.key` is missing on a later start (for example a restore from an old backup without it), `FileStore` creates a new one instead of failing. Every token then becomes invalid, and users sign in again.

### 4.3 Files on disk
```
backend/data/                  (git-ignored. On the VPS: /opt/wms/backend/data, owner wms:wms, mode 0750,
                                backed up nightly by wms-backup.timer, §11.4. Locally: copy the folder)
  .lock
  .demo                        only in test and demo copies: lets config.fake_now apply (R1); never in live data
  secret.key
  initial-admin.txt            first-start admin password (deleted after the first password change)
  plan.json      plan.json.bak
  users.json     users.json.bak
  days/2026-11-11.json         one file per date: frozen plan (past dates) + runs
  files/0b/0b6e1c2a-....jpg    photos and signatures
  audit/2026-11.jsonl          one line per write request
```

### 4.4 plan.json (everything the office plans)
```json
{
  "schema": 1,
  "frozen_through": "2026-11-10",
  "seeded_years": [2026],
  "settings": { "rollover_hour": 4 },
  "seq": { "customer": 40, "route": 42, "task": 6 },
  "waste_types": [
    { "code": "REL", "name": "REL", "abbr": "REL", "unit": "kg", "weigh_method": "on_site",
      "routable": true,  "recurring_tasks": false, "confirm_over": 1000, "active": true },
    { "code": "OTC", "name": "OTC", "abbr": "OTC", "unit": "kg", "weigh_method": "on_site",
      "routable": false, "recurring_tasks": false, "confirm_over": 1000, "active": true },
    { "code": "COMPACTOR", "name": "COMPACTOR", "abbr": "COMPACTOR", "unit": "kg", "weigh_method": "on_site",
      "routable": false, "recurring_tasks": true,  "confirm_over": null, "active": true }
  ],
  "trucks": [ { "plate": "SBA1234X", "active": true }, { "plate": "GBA1234X", "active": true } ],
  "holidays": [ { "date": "2026-12-25", "name": "Christmas Day" } ],
  "customers": [
    { "id": 12, "code": "C0012", "name": "ABC Restaurant", "address": "12 Jalan Besar",
      "phone": "+65 9123 4567", "note": "bins at back lane", "waste_types": ["REL", "OTC"], "active": true },
    { "id": 40, "code": "C0040", "name": "Golden Bakery", "address": "5 Tuas South Ave 2",
      "phone": "", "note": "", "waste_types": ["REL", "COMPACTOR"], "active": true }
  ],
  "routes": [
    { "id": 5, "code": "N1", "color": 1, "type": "regular", "name": "North 1 · Woodlands", "note": "", "rev": 4,
      "start": "2026-11-02", "end": null, "days": [1, 3, 5],
      "stops": [ { "customer_id": 12, "note": "3 bins" },
                 { "customer_id": 40, "note": "" } ] },
    { "id": 7, "code": "S1", "color": 5, "type": "special", "name": "Sunday Market", "note": "", "rev": 1,
      "start": "2026-11-15", "end": null, "sun": true, "ph": true, "stops": [ { "customer_id": 21, "note": "" } ] },
    { "id": 41, "code": "A1", "color": 2, "type": "adhoc", "name": "Adhoc 12 Nov", "note": "Call 11 Nov 09:10 (Mr Tan): overflow",
      "rev": 1, "date": "2026-11-12", "copied_from": null, "stops": [ { "customer_id": 12, "note": "" } ] },
    { "id": 42, "code": "N1-25", "color": 1, "type": "special", "name": "North 1 · Woodlands (from Fri 25 Dec)", "note": "",
      "rev": 1, "date": "2026-12-25", "copied_from": { "route_id": 5, "date": "2026-12-25" },
      "stops": [ { "customer_id": 12, "note": "3 bins" }, { "customer_id": 40, "note": "" } ] }
  ],
  "route_overrides": [
    { "route_id": 5, "date": "2026-11-18", "cancelled": false, "stops": null, "note": "use small truck" }
  ],
  "tasks": [
    { "id": 3, "waste_type": "COMPACTOR", "customer_id": 40, "note": "Bin at loading bay", "rev": 2,
      "start": "2026-11-03", "end": null, "days": [2, 5] },
    { "id": 6, "waste_type": "OTC", "customer_id": 12, "note": "Old furniture", "rev": 1,
      "date": "2026-11-11", "copied_from": null }
  ],
  "task_overrides": [
    { "task_id": 3, "date": "2026-11-20", "cancelled": true, "note": "Customer closed for renovation" }
  ]
}
```
Field notes:
- **Settings.** `rollover_hour` (0–6, default 4) is the day rollover for night shifts (R1). Only an admin changes it, on the Settings page.
- **Routes.**
  - A route that has `date` is a one-off. Any other route is recurring.
  - In `stops`, array order is visit order. A stop is `{customer_id, note}`.
  - `copied_from` (on a one-off route or task) links it to the occurrence it was copied from (R15, R19). The name `from` is used only by the change-schedule body.
- **Overrides.**
  - Route override: `stops: null` means inherit from the template.
  - Task override: has only `cancelled` and `note`.
- **Tasks.** A task that has `date` is a one-off; otherwise it is recurring (`start`, `end`, `days`).
- **Holiday list.** It is kept sorted by date.
- **Never deleted.** Customers and waste types are never deleted, so every id or code in history still resolves.

### 4.5 users.json
```json
{
  "seq": 5,
  "users": [
    { "id": 1, "username": "admin", "name": "Admin", "role": "admin", "lang": "zh",
      "password_hash": "$2y$10$...", "must_change_password": true, "active": true,
      "token_version": 1, "failed_logins": {} },
    { "id": 3, "username": "ali", "name": "Ali", "role": "driver", "lang": "en",
      "password_hash": "$2y$10$...", "must_change_password": false, "active": true,
      "token_version": 2, "failed_logins": {} }
  ]
}
```

### 4.6 Holiday seed (`backend/seed/holidays-sg.json`)
Singapore 2026, from the MOM list:

| Date | Day | Name |
|---|---|---|
| 2026-01-01 | Thu | New Year's Day |
| 2026-02-17 | Tue | Chinese New Year |
| 2026-02-18 | Wed | Chinese New Year (2nd day) |
| 2026-03-21 | Sat | Hari Raya Puasa |
| 2026-04-03 | Fri | Good Friday |
| 2026-05-01 | Fri | Labour Day |
| 2026-05-27 | Wed | Hari Raya Haji |
| 2026-05-31 | Sun | Vesak Day |
| 2026-06-01 | Mon | Vesak Day (observed) |
| 2026-08-09 | Sun | National Day |
| 2026-08-10 | Mon | National Day (observed) |
| 2026-11-08 | Sun | Deepavali |
| 2026-11-09 | Mon | Deepavali (observed) |
| 2026-12-25 | Fri | Christmas Day |

- **2027: to be entered from the MOM list.**
  - The developer copies the official 2027 Singapore list (mom.gov.sg, public holidays) into the seed file in M2, and the user confirms it.
  - Do not guess lunar, Islamic or Hindu dates.
  - Until 2027 is entered, the `missing_holiday_years` banner reminds users.
- The seed file is grouped by year and imported once per year (R16 `seeded_years`). After that, users maintain holidays on the Holidays page.

### 4.7 days/YYYY-MM-DD.json (frozen plan + runs)
```json
{
  "date": "2026-11-11",
  "plan": null,
  "runs": {
    "r5": {
      "job": "r5",
      "driver_id": 3,
      "holds": [
        { "driver_id": 5, "vehicle_no": "SBA1234X", "by": "self", "from": "2026-11-11T07:30:00+08:00",
          "to": "2026-11-11T10:15:00+08:00", "end": "switched" },
        { "driver_id": 3, "vehicle_no": "GBA1234X", "by": "self", "from": "2026-11-11T10:40:00+08:00",
          "to": null, "end": null }
      ],
      "removed": [9],
      "visits": {
        "12": {
          "customer_id": 12, "outcome": "collected",
          "weights": { "REL": 120.5 }, "tickets": {},
          "photos": ["files/0b/0b6e1c2a-7f3d-4c55-9a1e-2b9d6a0c31f1.jpg"], "signature": null,
          "reason": null, "note": "", "why": "re-weighed at depot",
          "driver_id": 5, "by": "user:2",
          "customer": { "code": "C0012", "name": "ABC Restaurant", "address": "12 Jalan Besar" },
          "captured_at": "2026-11-11T09:14:03+08:00", "received_at": "2026-11-11T09:14:05+08:00",
          "rev": 2, "flags": ["OFFICE_EDITED"],
          "ops": [ { "op_id": "1b9d6bcd-...", "result": "applied" }, { "op_id": "77aa0c1e-...", "result": "applied" } ],
          "history": [
            { "rev": 1, "at": "2026-11-11T09:14:05+08:00", "by": "user:5", "op_id": "1b9d6bcd-...",
              "outcome": "collected", "weights": { "REL": 12.5 }, "tickets": {},
              "photos": ["files/0b/0b6e1c2a-7f3d-4c55-9a1e-2b9d6a0c31f1.jpg"], "signature": null,
              "reason": null, "note": "", "why": null, "rejected": false }
          ]
        }
      }
    },
    "t6": {
      "job": "t6", "driver_id": 3,
      "holds": [ { "driver_id": 3, "vehicle_no": "GBA1234X", "by": "self", "from": "2026-11-11T11:02:00+08:00", "to": null, "end": null } ],
      "removed": [],
      "visits": {}
    }
  },
  "dropped_runs": []
}
```
- **Run.**
  - It is addressed by `(date, job)`, where `job` = `r<route_id>` or `t<task_id>`. The file's `date` is the operational date (R1); on a night shift its hold and visit timestamps can fall on the next calendar day before the rollover, for example `2026-11-12T02:40:00+08:00`.
  - `driver_id` is the current holder, or null.
  - `holds` is append-only. `end` is one of `finished`, `left`, `switched`, `released` or `reassigned`.
  - A run stores no status, no stop list and no copy of the route name.
  - `removed` lists customers the office dropped from the job's stop list while the run existed (R26). It only widens what R28 accepts as `OFF_PLAN`.
  - `dropped_runs` holds runs whose job was removed from the plan with `release_run` (R26). They are kept for history and never displayed.
- **Visit.**
  - `by` is the user who wrote the current version.
  - `driver_id` is the driver credited with the collection.
  - `flags` is a subset of `OFF_PLAN`, `LATE`, `CONFLICT` and `OFFICE_EDITED`.
  - `history` holds every earlier version and every rejected body.
- **`plan` for a past date** (written by R13). It includes cancelled and holiday_skipped occurrences, and snapshots identity so that later renames never change the past:
```json
[
  { "key": "r5@2026-11-06", "kind": "route", "route_id": 5, "code": "N1", "color": 1, "type": "regular",
    "name": "North 1 · Woodlands", "note": "", "status": "scheduled", "edited": false,
    "recurring": true, "days": [1, 3, 5], "sun": null, "ph": null, "copied_from": null,
    "stops": [ { "customer_id": 12, "note": "3 bins" }, { "customer_id": 40, "note": "" } ] },
  { "key": "t3@2026-11-06", "kind": "task", "task_id": 3, "waste_type": "COMPACTOR", "customer_id": 40,
    "recurring": true, "days": [2, 5], "start": "2026-11-03", "end": null, "copied_from": null,
    "note": "", "status": "scheduled", "edited": false }
]
```
The snapshot carries every field the drawer header and rows show, so a past date renders purely from it, even after "Delete route" or a schedule split. Only `covered_by` is computed on read (from the one-offs' `copied_from`), because a copy can be made from a past date later.

### 4.8 Derived shapes (computed on read, never stored)
**RouteOccurrence**
```json
{ "key": "r5@2026-11-11", "kind": "route", "route_id": 5, "code": "N1", "color": 1, "type": "regular",
  "name": "North 1 · Woodlands", "date": "2026-11-11", "recurring": true, "days": [1,3,5], "sun": null, "ph": null,
  "status": "scheduled", "edited": false, "frozen": false, "note": "", "rev": 4,
  "copied_from": null, "covered_by": [],
  "stops": [ { "seq": 1, "customer_id": 12, "note": "3 bins", "visit": VisitSummary|null } ],
  "off_plan": [ { "customer_id": 9, "visit": VisitSummary } ],
  "run_status": "active", "run": RunSummary|null }
```
- `covered_by` is `[{"route_id", "code", "date"}]`: the one-off copies whose `copied_from` points at this occurrence. The UI renders it as "covered by N1-25 (Fri 25 Dec)".
- `off_plan` lists visits in this run for customers that are not on the stop list (R28).

**TaskOccurrence**
```json
{ "key": "t6@2026-11-11", "kind": "task", "task_id": 6, "waste_type": "OTC", "customer_id": 12,
  "date": "2026-11-11", "recurring": false, "days": null, "status": "scheduled", "edited": false, "frozen": false,
  "note": "Old furniture", "rev": 1, "copied_from": null, "covered_by": [],
  "visit": VisitSummary|null, "run_status": "active", "run": RunSummary|null }
```
- `covered_by` is `[{"task_id", "date"}]`, computed like the route version. A cancelled source row shows "→ Sat 21 Nov".
**RunSummary**
```json
{ "driver": { "id": 3, "name": "Ali" }, "vehicle_no": "GBA1234X", "holders": ["Bala", "Ali"], "left_by": null,
  "collected": 3, "missed": 0, "pending": 5, "total": 8, "totals": { "REL": 420.5 },
  "last_activity_at": "2026-11-11T10:12:00+08:00", "flagged": 1 }
```
**VisitSummary**
```json
{ "outcome": "collected", "weights": { "REL": 120.5 }, "tickets": {}, "reason": null, "note": "",
  "driver": "Bala", "at": "2026-11-11T09:14:05+08:00", "rev": 2, "flags": ["OFFICE_EDITED"],
  "photos": 1, "signature": false }
```

---

## 5 Calendar logic

### 5.1 Two regimes
"today" below is the op_date (R1): from 00:00 until the rollover (default 04:00) it is still the previous calendar date.

| Date | Plan comes from | Runs |
|---|---|---|
| d < today | `days/<d>.json.plan` (frozen, R13) | `days/<d>.json.runs` |
| d = today | computed live from `plan.json` | `days/<today>.json.runs` |
| d > today | computed live from `plan.json` | none (runs never exist for future dates) |

### 5.2 Route generation (server, `Schedule::routesOn(plan, d)`)
```
holiday = plan.holidays has d ; dow = isoWeekday(d)
for r in plan.routes:
  if r.date:                       # one-off
     if r.date == d: emit(r, 'scheduled')
     continue
  if d < r.start or (r.end and d > r.end): continue
  if r.type == 'regular' and dow in r.days:
     emit(r, holiday ? 'holiday_skipped' : 'scheduled')
  if r.type == 'special' and ((r.sun and dow == 7) or (r.ph and holiday)):
     emit(r, 'scheduled')          # once, even when a Sunday is also a PH
for each emitted recurring occurrence with an override on d:
  if override.cancelled and status == 'scheduled': status = 'cancelled'
  note = override.note ; edited = true
stops = effectiveStops(r, d)       # R8: override.stops ?? route.stops, minus inactive/non-routable
```

### 5.3 Task generation (server, `Schedule::tasksOn(plan, d)`)
```
for t in plan.tasks:
  if t.date: if t.date == d: emit(t, 'scheduled'); continue
  if t.start <= d and (not t.end or d <= t.end) and isoWeekday(d) in t.days:
     emit(t, 'scheduled')          # holidays and Sundays included
  apply task override (cancelled -> 'cancelled', note, edited)
```

### 5.4 What each kind of day allows
| Day | regular | recurring special | adhoc | special one-off | tasks (OTC / COMPACTOR) |
|---|---|---|---|---|---|
| Mon–Sat work day | runs on its weekdays; a one-off copy is allowed (R15) | – | allowed | not allowed | allowed, run |
| Mon–Sat PH | **paused** (`holiday_skipped`) | runs if `ph` | not allowed | allowed | allowed, run |
| Sunday | never | runs if `sun` | not allowed | allowed | allowed, run |
| Sunday that is a PH | never | runs once if `sun` or `ph` | not allowed | allowed | allowed, run |

`day.can_create`:
- work day: `["regular", "adhoc", "task"]`;
- rest day: `["special", "special_once", "task"]`;
- past day: `[]`.

### 5.5 Overrides, holidays and edits
- An override changes one date of a recurring route (stops, note, cancelled) or of a recurring task (note, cancelled). Overrides are cleaned up per R9 and R19.
- Adding or removing a holiday instantly recomputes every recurring route from today on. Stored one-offs are protected by `HOLIDAY_CONFLICT` (R16), and today's runs by `RUN_EXISTS` (R26). Tasks are unaffected.
- A holiday_skipped regular occurrence is not runnable. The office resolves it with Copy to date (R15): "Run on PH" (special one-off on the same date) or "Move to work day" (regular one-off). The paused row then shows "covered by N1-25 (Fri 25 Dec)".

### 5.6 Run overlay and status
- For every occurrence dated ≤ today, the server attaches the run `runs[job]`, if there is one, and derives `run_status` (R22), the counts and the totals.
- A run whose occurrence is missing cannot arise for today, because R26 prevents it. If one is ever found (for example after a manual file edit), it is shown as an orphan row with the "plan changed" mark, never hidden.

### 5.7 Past lock and freeze
- At the start of every request, R13 freezes every day up to yesterday (op_date − 1), so a day freezes at its rollover, not at midnight.
- Plan writes for dates before today are refused (R11).
- On a past date the office can still work on run data: enter, correct and close out results.

### 5.8 Order and grouping inside one day (used by every view)
1. A **Tasks** group comes first: task occurrences sorted by waste-type order, then by customer name.
2. **Routes** follow, scheduled and cancelled: adhoc first, then by code in natural order (R5).
3. A **Paused** group comes last: the holiday_skipped regular routes, collapsed into one line.

### 5.9 Calendar request
- `GET /api/calendar?view=week|month&anchor=D` returns the whole grid. Weeks start on Monday, and the month grid is 6 × 7.
- For each day the server sends `class`, `holiday`, `past`, `can_create`, `ops` (today and past days only), `totals`, and the occurrence lists.
- The client never computes a weekday, a day class, a status or a lock. It only renders, filters, searches and highlights.

---

## 6 Office edit semantics

**Guiding rule.**
- A date cell edits what you see on that date.
- Dates before today are a read-only plan. On them the office can only work on run data: results, close-out and back-fill.

### 6.1 Route container (drawer) and draft
- Clicking a route row (week view) or chip (month view) opens the **route drawer** for (route, date):
  - Header: colour bar, CODE, type tag, name, the rule ("Regular · Mon Wed Fri" / "Special · every Sunday + every PH" / "Adhoc · only Thu 12 Nov"), the note and the status line.
  - Body: the stop list. Each row shows a drag handle (⠿), the customer, address, the customer's **routable** type tags only (REL) and the result, with ↑ ↓ ✕ controls. Clicking the seq number lets you type a new position ("move to #"), which helps on long lists.
  - **Reorder** has three equal ways, and all of them only change the draft order (the same `arrayMove`):
    - **Drag and drop** (`@dnd-kit/core` + `@dnd-kit/sortable`, §11.1) by the ⠿ handle, so a click on the row still works:
      - mouse (`MouseSensor`): the drag starts after 5 px of movement;
      - touch (office tablet, `TouchSensor`): press and hold the handle 200 ms (5 px tolerance), so a normal swipe still scrolls the list;
      - keyboard: focus the handle, Space to lift, ↑ ↓ to move, Space to drop, Esc to cancel; the moves are announced to screen readers;
      - the list scrolls automatically near the drawer's top and bottom edges, the dragged row shows a shadow and a placeholder marks the drop position, and seq numbers renumber on drop.
    - **↑ ↓** buttons, one step at a time.
    - **Move to #**: type a position in the seq field.
  - Visited rows (today with a run) can be reordered too; they keep their result. Nothing is saved until [Save]. The same `StopList` component is used by the Routes page template editor.
  - OTC and COMPACTOR are never tagged inside a route container (user rule). A customer's OTC or COMPACTOR work appears only as an "also on: OTC task" link, and only when such a task exists that day. The same holds for route search hits and the driver's S2, S3 and S4 stop cards.
  - Footer: [Save] [Cancel] and a menu.
- **Edits** go into a local draft keyed by the occurrence key:
  - add customer;
  - remove (✕);
  - reorder (drag and drop, ↑ ↓ or move to #);
  - stop note;
  - occurrence note.

  The draft shows an amber outline, struck-through removed rows, and sticky [Save] [Discard]. It survives the 30 s refetch.
- **Customer picker.**
  - It searches name, code and address, and lists **only routable customers** (R10). Customers with only OTC or COMPACTOR never appear.
  - It hides customers already in the list and archived customers.
  - It labels customers "also on N2 that day".
  - It ends with **Create new customer**: name, address, phone and waste-type chips, with REL pre-ticked and at least one routable type required. The customer is created at once and added to the draft.
- **Today with a run.**
  - Visited rows show their result and have no ✕.
  - Pending rows can be added, removed and reordered freely. The driver sees the change within 30 s.
- **On Save:**
  - A one-off saves directly.
  - A recurring route opens the scope dialog (§6.2).
- On 409 `STALE_REVISION`, the drawer refetches and keeps the draft. The user saves again or discards.

### 6.2 Scope dialog (recurring routes)
- (•) **Only Wed 18 Nov**: writes `override.stops` and note.
- ( ) **Wed 18 Nov and all following**: per R12, a template replace (when 18 Nov is the next date the route runs) or a split from 18 Nov (R14, same code, so the calendar looks the same).
- The dialog lists "Not changed: Mon 23 Nov, Fri 27 Nov (they have their own list)".
- For today's container with a run, it adds the driver impact, computed client-side from the loaded payload. Example: "N1 (Ali, 3/8) will get 1 new stop".

### 6.3 Skip / restore / reset / delete
- **Recurring route:**
  - Menu "Skip this date" sets `cancelled = true`. The row becomes a struck-through ghost with [Restore].
  - "Reset to route default" deletes the override.
- **One-off route:** [Delete], after a confirmation.
- All of these are subject to R26 on today.

### 6.4 Copy to date (R15)
- The dialog has:
  - a target date ≥ today;
  - the resulting type, from `GET /api/routes/suggest-code?type=copy` (called whenever the date changes): "Regular (only this date)" on a work day (or "Adhoc" when the source is adhoc), "Special (only this date)" on a rest day;
  - the suggested code (editable) and name;
  - "Skip the original", ticked by default when the source is a runnable recurring date. If the source is today and has a run, the R26 dialog (§6.11) applies and the resend carries `release_run`.
- **Paused (PH) regular routes**:
  - In the day column they collapse into one grey line, "⏸ 3 regular routes paused (PH) ▸".
  - Each expanded row has [Run on PH], a copy to the same date (special one-off), and [Move to work day…], a copy to a chosen work date (regular one-off, R tag, not adhoc).
  - A covered row shows "→ N1-25 Fri 25 Dec".
- **Moving a one-off** is "Change date" in its menu. The new date is re-validated by R6.

### 6.5 Route schedule and identity
- **Edit route** form:
  - code;
  - colour (10 swatches);
  - name;
  - note;
  - Mon–Sat chips (regular) or Every Sunday / Every PH (special);
  - start and end.
- **Apply** has two choices:
  - (•) from today: a template edit;
  - ( ) from date D…: R14.
- "End route from date D" sets `end = D − 1`.
- "Delete route" removes the route and its overrides. Past days are unaffected, because they are frozen. R26 applies.

### 6.6 "+ Route" in a day cell (only `can_create`)
- **Work day**: [Regular · repeats weekly] or [⚡ Adhoc · this date only].
  - The Regular form pre-ticks the clicked weekday, sets start to the clicked date, and shows "First run: Wed 18 Nov".
  - The Adhoc code defaults to `A<n>`, its name to "Adhoc 12 Nov", and its note records the caller and the reason.
- **Rest day**: [Special · every Sunday/PH] or [Special · this date only].
- **Past day**: none of these are offered.

### 6.7 Urgent pickup (REL, the user's example)
- The dialog has:
  - date chips: [Today] [Next work day (default, from `/api/meta`)] [Pick…]. Whenever the date changes, the dialog calls `GET /api/routes/suggest-code?type=adhoc&date=…`, which returns the code, the day class and the resulting type;
  - a multi-add customer picker (routable customers only) with quick-create.
- **Target:**
  - (•) **New one-off.** On a rest date the label visibly switches to "Special, only this date" with a one-line reason; it is never converted silently.
  - ( ) **Add to an existing route on that date.** This is an "only this date" edit. If that route is running today, the driver gets the stops live.
- It takes about 4 interactions.
- A footer link reads "Is this OTC or COMPACTOR? Create a task instead" and opens §6.8.

### 6.8 Tasks (OTC / COMPACTOR)
- **"+ Task"** is in the top bar and in every day cell from today onward. The dialog has:
  1. **Type**: chips of the active non-routable types (OTC, COMPACTOR).
  2. **Customer**: a search over all active customers.
     - Customers registered for the type are listed first.
     - Others show [Add OTC to this customer], which PATCHes the customer and then selects it, because R17 needs the type registered.
     - "Create new customer" pre-ticks the type.
  3. **When**:
     - One-off date: default is the clicked date or today; any day is allowed.
     - Recurring (only when `recurring_tasks`): Mon–Sun chips, start (default the clicked date) and an optional end.
     - A recurring task shows the hint "Runs on public holidays too; skip single dates if needed."
  4. **Note**.

  Save sends `POST /api/tasks`.
- **Task drawer**, opened by clicking a task row:
  - Content: type, customer (with address and phone), schedule, note, status and driver, the result (weights, ticket, photos, signature) and the history.
  - Menu for a one-off: [Edit note] [Change date] [Delete].
  - Menu for a recurring date: [Skip this date] / [Restore] [Move this date…] [Edit series (days, end)] [End series from date] [Delete series].
  - Run actions as in §6.12.
  - Every write is rev-checked (R20) and subject to R26 on today.
- **Tasks page**: the full list (§9.2).

### 6.9 Customers
- "Edit customer" (from the Customers page or from a stop or task menu) saves at once and applies everywhere ("Changes this customer everywhere").
- ✕ on a stop removes the stop, never the customer.
- Removing a waste type that is in use shows the `CUSTOMER_IN_USE` list with [Remove from these routes/tasks and save] (`detach: true`) or [Cancel].
- **Archive**: a confirmation lists everything that will be removed, and the result dialog lists what was removed.
- **Restore** re-adds nothing.

### 6.10 Holidays page
- One list per year, with add, edit and delete for dates ≥ today. Past rows show a lock.
- `HOLIDAY_CONFLICT` lists the one-off routes to change first, with links.
- `RUN_EXISTS` appears when today is affected.
- A banner appears when a year in view or within 60 days has no holidays.

### 6.11 Blocked by a run (R26)
- **Which writes can be blocked**: any write that would un-schedule today's job while it has a run. That covers:
  - skip, including Copy with "Skip the original";
  - delete;
  - end;
  - a schedule change;
  - a one-off date change;
  - a holiday change;
  - a task change: skip, move, delete, end or a date change;
  - a customer detach or archive.
- **When nothing has been done yet** (resolved = 0), the dialog reads "Ali has N1 (0 done). [Release Ali and continue] [Cancel]". The second attempt is sent with `release_run`.
- **When work has been done** (resolved ≥ 1), the dialog reads "Refused: Ali has done 3 of 8. Close out, or remove only the pending stops, then re-plan the leftovers." Today's menu items are disabled, with the tooltip "Ali has this job".

### 6.12 Run actions (office; routes and tasks)
- **Today:**
  - [Assign driver ▾]: a list of active drivers, each showing their current route, so the office can see conflicts (R24).
  - [Release]: gives the job back. Shown only when the job has a holder.
  - [Close out]: every pending stop becomes missed with `not_visited`. On a `not_started` job, which has no run, it creates a holder-less run with every stop missed (R21).
  - [Enter / correct results].
- **Past cells:**
  - `incomplete`: [Close out] and [Re-plan leftovers…]. Re-plan opens Urgent pickup prefilled with the not-visited customers, or Copy for a task.
  - `no_record`: [Enter results], a back-fill (R29), and [Close out], which marks every stop `not_visited` in one action instead of one dialog per stop.
- **Result dialog.** Clicking any stop row or task opens it. It contains:
  - outcome;
  - a weight per weighable type and tickets;
  - photos (view, add, remove) and signature (view, remove);
  - reason and note;
  - driver (for a new visit only);
  - **why**, required when changing an existing visit;
  - the history list, with every revision, who wrote it, when and why, and rejected bodies marked.

---

## 7 Driver flow & state machine

### 7.1 Server-derived job states (R22; never stored)
| State | Meaning | Driver sees |
|---|---|---|
| planned | a future date | not listed (drivers see today only) |
| not_started | today, no run (or a run with no holder and nothing resolved, R22) | Available |
| active | a run with a holder and pending > 0 | "Mine" or "Taken by X" |
| open | a run with no holder and pending > 0 | **Needs driver** (anyone, including the previous holder) |
| done | pending = 0 | Done |
| incomplete | a past date with pending > 0 | not listed; the office closes it out |
| no_record | a past date with no run | not listed; the office back-fills |

### 7.2 Device-only states
- **preview**: a selected but unconfirmed job. Nothing is written to the server and nothing is reserved.
- **draft**: the form values of a stop or task. They are saved to IndexedDB on every change.
- **outbox entry**: an unsent result write plus its photos.
- **not sent**: an entry the server refused (422 or `NOT_HOLDER`). It stays visible and editable.

### 7.3 A driver's day
1. **Log in** once with a username and password. The token lasts 30 days and is revoked by a password change or a deactivation.
2. **Today (S1)** lists the jobs of the op_date (R1): a night shift from 22:00 Wed to 03:00 Thu works entirely on Wednesday's jobs, and Thursday's jobs appear at 04:00. S1 has a **My work** block and two tabs:
   - My work shows the held route, the held tasks and any job the office assigned.
   - **Routes** has the sections Needs driver, Available, Taken and Done.
   - **Tasks** has the same sections: Needs driver, Available, Taken and Done.
3. **Select** a route or task. This opens a read-only preview (S2 or S2T) with a truck-plate picker, pre-filled with this phone's last plate (or the plate of the driver's current route for a task).
4. **Confirm** = claim (R23). It needs the network.
   - 201 or 200: the run view (route) or the result form (task) opens.
   - 409 `RUN_TAKEN`: the app shows "Taken by Chong 07:45" and refreshes the list.
   - 409 `DRIVER_HAS_ACTIVE_RUN` (a route while holding another route): the Switch sheet opens (§7.5).
   - 422 `NOT_TODAY` or `NOT_RUNNABLE`: the list refreshes.
5. **Each route stop (S4)**: enter a weight for each of the customer's routable types (REL), plus a ticket where `weigh_method = weighbridge`, optional photos, an optional signature and a note.
   - [Collected: save & next] saves the stop, puts it in the outbox and opens the next pending stop.
   - Or [Not collected], then a reason.
   - Stops can be done in any order.
6. **A task (S4 for the task)**: the same form, with a single weight field for the task's type (OTC or COMPACTOR). On save the task becomes done, and the app returns to Today.
7. **Route end**:
   - When pending = 0: [Finish route].
   - Otherwise: [Leave route…] (S5), with two choices: give back (the route becomes open) or mark the rest not collected with a reason (the route becomes done).
8. **Next job**: pick the next route (one route at a time) and take any tasks at any time.

A customer on the route asks for extra bulky waste? The driver **calls the office**, because drivers cannot add customers or other waste types on site (the server enforces this: `NOT_ON_JOB`, `TYPE_NOT_ALLOWED`). The office creates an OTC task for that customer today, and the driver takes it from the Tasks tab, which is allowed while holding the route.

### 7.4 Transitions (each is one locked server transaction)
| # | Trigger | From → To | Effect |
|---|---|---|---|
| T1 | Driver claims | not_started → active | run created; hold appended |
| T2 | Driver claims an open job | open → active | same run continues; earlier visits keep their driver_id |
| T3 | Office assigns X | not_started / open / active(Y) → active(X) | Y's hold ends `reassigned`; X picks a plate on opening |
| T4 | Result write | active / open → done when pending = 0 | visit stored per R27–R30 |
| T5 | Undo, or office adds a stop | done → active (holder still set) or open | — |
| T6 | Leave / give back / finish | active → open, done, or not_started (resolved = 0; the run and its holds are kept) | R24 |
| T7 | **Switch route midway** | T6 (`switched`) on the old route + T1/T2 on the new one, atomically | old route's remaining stops become **Needs driver** |
| T8 | Office release | active → open, done, or not_started (run kept) | `end = released` |
| T9 | Office close-out | not_started / active / open / incomplete / no_record → done | pending → missed `not_visited`; creates a holder-less run when there is none (R21) |
| T10 | Plan edits | derived | adding a stop reopens a done run; removing pending stops can complete it; a removed visited customer stays `OFF_PLAN`; un-scheduling is blocked (R26) |
| T11 | Day rollover (R1, default 04:00, not midnight) | active / open → incomplete; not_started → no_record | no write; the outbox can still deliver first results at any time (`LATE` unless captured before the rollover during the driver's hold, R28) and queued corrections until the edit deadline, rollover + 8 h = 12:00 by default (R28) |
| T12 | Office back-fill | not_started / no_record → a run with no holder: open (today) or incomplete (past), or done once every stop is entered | R29 |

Tasks use the same machine with a stop list of one customer: T1–T3, T4 (done when the single visit is resolved), T5, T6 (give back), T8, T9, T11 and T12. T7 does not apply, because tasks never conflict.

### 7.5 Switch route midway
- **When it is offered:**
  - from the run's overflow menu, [⇄ Switch route];
  - when the driver confirms another route while holding one.
- **The sheet** reads: "Leave W2? 3 stops done, 5 left. The 5 go back to Needs driver; your 3 stay recorded under your name." It offers [Switch to ⚡A2] and [Cancel, keep W2].
- **Server**: `claim {switch: true}` (T7) runs in one transaction. If the target is taken or not runnable, nothing changes and the driver keeps W2.
- **Unsaved stop values**: if a stop form has any, the sheet warns first. The values stay as a device draft.
- **Tasks the driver holds are unaffected.**

### 7.6 Corrections after submit (who, how, audit)
| Who | What | Until when | How | Audit |
|---|---|---|---|---|
| Driver | their own visits (they wrote them last) on today's (op_date) jobs | until the rollover (default 04:00) in the UI; a correction queued before the rollover is still accepted until the edit deadline (rollover + 8 h = 12:00 by default, R28) | Done list → reopen S4 → [Save correction] or [Undo (back to pending)] | `history` entry {rev, at, by, op_id, old values} |
| Office or admin | any visit, any job, any date | no limit | Result dialog; `why` is required | `history` + flag `OFFICE_EDITED` + audit-log line |
| Conflicting write | a stale write from another principal | — | refused with 409 `VISIT_CHANGED`; the phone shows the server value | the rejected body is stored in `history` (`rejected: true`) + flag `CONFLICT` for office review |

After the rollover (default 04:00), the previous day's jobs are no longer listed, and the app says "Call the office to change this." Between midnight and the rollover, a night-shift driver still sees, claims and corrects the previous date's jobs as today's.

### 7.7 Offline outbox (`src/driver/outbox.ts`, IndexedDB via `idb-keyval`)
- **Stores:**
  - `files`: uuid → {blob, ext, uploaded}.
  - `outbox`: key `<date>/<job>/<customer_id>` → {body, op_id, base_rev, file refs, created_at}.
  - `notsent`: refused entries.
- **Coalescing**: a new edit to the same stop replaces the entry with the new body and a new `op_id`, unless that entry is in flight. File blobs that are no longer referenced are deleted.
- **Flush:**
  - Entries are sent one at a time, in insertion order, with a 15 s timeout. For each entry, its photos and signature are uploaded first (`PUT /api/files/...`, which is idempotent), then the visit is sent with PUT.
  - A flush starts after every save, on the `online` event, on focus, and every 15 s (backing off to 60 s while it fails).
- **Results:**
  - 200 (including a replay): the entry and its blobs are dropped, and `base_rev` is updated.
  - 409 `VISIT_CHANGED`: the entry is dropped, a toast is shown, and the server value is displayed.
  - 409 `NOT_HOLDER`, 422 `EDIT_WINDOW_CLOSED`, `NOT_ON_JOB` or any other 422: the entry moves to **Not sent** (S7), where the values stay visible and can be edited and resent.
  - 401: the outbox is kept, the app asks for the password, then resumes.
  - Network error or 5xx: the outbox stops and retries later.
- **Logout** is refused while the outbox is not empty.
- **Eviction**: after login the app calls `navigator.storage.persist()`, so the browser does not evict the outbox under storage pressure.
- **The UI:**
  - The run view merges server state with unsent entries, which carry a cloud icon until acknowledged.
  - The last `/driver/today` and job responses are cached per user and shown at once with their data time.
- **What needs signal**: claim, switch, give back and finish are disabled while offline, labelled "Needs signal".
- **Opening the app offline**: a service worker (`vite-plugin-pwa`, served over HTTPS) caches the app shell, so the app opens with zero signal. Service workers need a secure context, so offline and phone tests always go through the VPS's HTTPS origin (M1b onward), never `http://<pc-ip>` on the local Windows PC.

### 7.8 Edge-case coverage (from the edge-hunter list)
| Case | How v1 handles it |
|---|---|
| D01 claim race | R23 under the lock: the first claim wins, the second gets `RUN_TAKEN`. Claims are never optimistic. |
| D02 stale list | The claim re-expands the job (`NOT_TODAY`, `NOT_RUNNABLE`), then the list refreshes. |
| D03 wrong pick | The big CODE and colour on each card. Leaving with resolved = 0 makes the job Available again (R22); the run is kept (R24). |
| D04 switch midway | T7 is atomic. An unsaved form stays as a draft, with a warning. |
| D05 takeover + late sync | `LATE` flag (R28). Leave, release and reassign never delete the run, so the late write still finds it. A clash returns 409 and the body is kept in history (`CONFLICT`). |
| D06 office adds a stop | Live plan: a NEW badge on the phone. A done run reopens. |
| D07 office removes a stop | It disappears with a toast. The customer goes into `run.removed`, so a late collection is kept as `OFF_PLAN` (R26, R28). |
| D08 reorder | The app never re-sorts under an open form. Visits are keyed by customer_id. |
| D09 plan change after start | R26 `RUN_EXISTS`, with `release_run` when resolved = 0. |
| D10 calendar shows actuals | Frozen plan + run overlay, plus `no_record`. |
| D11 closed / no waste / refused | Missed reasons. An optional photo can serve as evidence. |
| D12 blank vs 0 | Every shown field is required, with a [0] chip. The server treats an absent type as 0 and requires at least one value > 0. |
| D13 unregistered type | Not on site: only the customer's registered routable types are weighable (`TYPE_NOT_ALLOWED` otherwise). The driver calls the office, which edits the customer; the form updates on the next poll. Task: not applicable. |
| D14 customer types change mid-run | Pending stops refresh on poll. An open form never changes. Visits keep their snapshot. |
| D15 waste-type list changes | R3: code, unit and routable are immutable, and deactivation is guarded. |
| D16 typos | "," is normalised. `confirm_over` asks for confirmation. Corrections follow R28/R29, with history. |
| D17 midnight / night shift | Midnight is not a boundary: the day rolls over at the configurable rollover hour (default 04:00, R1), so a night shift after midnight still works on the previous date's jobs (claims, results, totals, no `LATE`). The run date is fixed. After the rollover, first results still arrive at any time (`LATE` unless captured before the rollover, R28); queued corrections until the edit deadline (rollover + 8 h, R28); the driver UI shows only the new op_date. Tested at 03:59 vs 04:00 (§13). |
| D18 poor signal | IndexedDB outbox, idempotent `op_id`, service-worker app shell. |
| D19 dead phone / two devices | A run belongs to the driver, not the device. The same-principal rule (R30) applies. The office can back-fill. |
| D20 forgotten Finish | Status is derived. The office has Release and Close out, and sees "last activity". |
| D21 holiday changed on a day with runs | R26. |
| D22 adhoc or task added today | A "New today" banner on the next poll. The office can also assign. |
| D23 same customer on two jobs | R31. |
| D24 one driver, several jobs | Route jobs one at a time, with a plate per hold. Tasks in parallel. |
| D25 unplanned stop | **Not allowed** (user rule). The driver calls the office, which adds the customer to today's route or creates an OTC task. It shows on the phone within 30 s. |
| D26 what drivers are offered | Scheduled, today, pending ≥ 1 (routes and tasks). |
| D27 report date | No moves exist. Copies are real-date one-offs, and totals use the job's date. |
| D28 deployment | JSON + global lock. Linux VPS with Caddy (automatic HTTPS) + PHP-FPM, auto-start by systemd, nightly backup timer, one-shot `deploy/install.sh` (§11.4). Local trials on Windows with .bat files. |
| D29 identity | User accounts (R33/R34). |
| D30 totals | R32 in the calendar (daily totals per waste type only, user decision). CSV/Excel export is the first v2 item (§16). |
| D31 weighbridge | Per-type `weigh_method` plus a ticket per visit. Which types use a weighbridge, and per-load tickets: §15 Q1. |
| D32 "following" from today while live | R12 replaces the template, so today changes live. A removed visited customer stays `OFF_PLAN`. |
| D33 customer deactivated | Archive/detach (R4). Visits keep their snapshot. |
| D34 double coverage | The `copied_from` link plus the "covered by" label. "Skip the original" is ticked by default. |
| D35 finish with pending stops | The S5 Leave sheet. Undo works the same day. |
| D36 open questions | §15. |

---

## 8 Office<->driver sync & live status

### 8.1 Principle
- The plan is the only stop list, and a run adds only facts (holder, holds and visits).
- A driver's to-do list is the job's live effective stops minus the resolved visits. Every office edit to today's job therefore reaches the phone on the next poll, with no sync code and nothing to reconcile.
- Runs exist only for today and earlier dates, so edits to future dates never touch a run.

### 8.2 Office action → driver effect
| Office action | Phone (next poll, ≤ 30 s) |
|---|---|
| Add a customer to today's route ("this date", "following" or Urgent pickup) | The stop appears with a NEW badge. A done run reopens (active if the holder is still set, otherwise open). |
| Remove a pending customer, or archive/detach a customer | The stop disappears, with the toast "Office removed ABC Restaurant". A later offline collection for it is kept (`OFF_PLAN`). |
| Reorder, change a stop note or the route note, edit a customer | Pending stops update. An open form is never re-rendered; the changes apply after it is saved. Submitted visits keep their snapshot. |
| Create a task for today | It appears in the Tasks tab, with a "New task today" banner. |
| Assign a job to X | X sees "Assigned by office" in My work. The previous holder sees "Office moved N1 to Bala". |
| Release | The holder sees "Office took back N1 / the OTC task" and returns to Today. |
| Skip, delete or end today's job with a run | Blocked by R26. With `release_run` (resolved = 0), the phone shows "Office cancelled". |
| Close out | The job moves to Done. Pending stops show "not visited". |
| Correct a visit | The phone shows the new value. A queued driver edit with an older `base_rev` gets 409, and its body is kept (`CONFLICT`). |
| Back-fill | A job done on paper shows as done or open. |

### 8.3 How the calendar shows progress (status = icon + short text, never colour alone)
Rows show glyph + short word + count, like the mockup the user approved ("◑ 李明 进行中 3/8", "待接手"). The route name is truncated first, so the row stays on one line. Task rows use the same pattern without the count. Where the table shows `zh/en`, the row shows only the word in the user's language.

| Status (`run_status`; the last row is the occurrence status) | Route row (week view, one line) | Task row | Detail (tooltip and drawer) |
|---|---|---|---|
| planned | `8` (stop count, muted) | – | "Planned" |
| not_started | `○ 未领取/Unclaimed 0/8` | `○ 未领取/Unclaimed` | "Not started" |
| active | `◑ Ali 3/8` | `◑ Ali` | "Ali · 3/8 · GBA1234X · REL 420.5 kg · last activity 10:12" (grey "quiet 25 min" after 15 min with no activity) |
| open | `⇄ 待接手/Needs driver 3/8` (amber) | `⇄ 待接手/Needs driver` (amber) | "Needs driver · left by Bala 10:15" |
| done | `✓ Ali 8/8` (green) | `✓ Ali` / `✗ Not collected` | "Done · 1 missed · REL 980 kg · Bala → Ali" |
| incomplete | `! Incomplete 6/8` (red) | `! Incomplete` (red) | "Incomplete" + [Close out] |
| no_record | `– No record` (grey) | `– No record` | [Enter results] [Close out] |
| cancelled | struck-through ghost "skipped" | struck-through | [Restore] |

- **Today's day header** shows the ops line `○3 ◑6 ⇄1 ✓2` and the totals "REL 2,410 kg · OTC 300 kg · COMPACTOR 5,200 kg" (provisional while any job is active or open).
- **Past day headers** show the totals plus counts of incomplete and no_record jobs.
- **Month chips** get a small status dot: green done, amber open, red incomplete, grey no record.
- **Today's day drawer**, sorted Needs driver, Not started, Working, Done, is the live dispatch board. No extra page is needed.

### 8.4 Driver-side sync
- `/api/driver/today` and the open job are polled every 30 s while the page is visible, and refetched after every action.
- The app compares job keys and customer ids with its last copy to show the NEW badge and the "New today" banner.
- When `today` in a response changes (the rollover passed, R36), the app drops the old day's lists, keeps the outbox (it still delivers per R28), and shows the toast "Day closed at {time}: showing Thu 12 Nov" (§9.1). An open stop form stays open; its save goes through the outbox as usual.
- Each response is a few KB.

---

## 9 Screens

### 9.1 Shared
- **Language**: zh and en, switchable per user in the header (`PATCH /api/me {lang}`); the choice is stored on the user. Data such as route names, customer names and waste-type names is shown as entered. Type names Regular/Special/Adhoc are kept in both languages. Dates are formatted per language: "11月11日 周三" and "Wed 11 Nov".
- **Rollover time in texts**: every text that names the rollover time ("until {time}", "Day closed at {time}", "appear at {time}") takes `{time}` from `/api/meta` `day_ends_at`, never a fixed "04:00", because H is an admin setting (R1). The "04:00" in this document's examples is the default. With H = 0 there is no time between midnight and the rollover, so the "until" texts never show.
- **Route palette** (index → colour, from the mockup):
  1. `#4E79A7`
  2. `#F28E2B`
  3. `#E15759`
  4. `#76B7B2`
  5. `#59A14F`
  6. `#EDC948`
  7. `#B07AA1`
  8. `#FF9DA7`
  9. `#9C755F`
  10. `#17BECF`
- **Office theme**: neutral chrome, so that the colour bars are the only colour signal. Codes are set in a monospace font. Light and dark themes come from CSS tokens.
- **Driver theme**: a high-contrast light theme, readable in sunlight.
- **Fonts**: system fonts only, no external font CDN.

### 9.2 Office (desktop-first, at `/`)
**Login.** Fields: username and password, plus a language toggle. A first login with `must_change_password` goes to "Set new password".

**Calendar** (the main page, as in the mockup):
- **Top bar**:
  - [‹] [Today] [›] and the range title;
  - [Week | Month];
  - [⚡ Urgent pickup] and [+ Task];
  - navigation: Calendar, Routes, Tasks, Customers, Holidays, Settings, Users (admin only);
  - user menu: language, change password, sign out everywhere;
  - the missing-holiday banner.
- **Filter bar**:
  - search: route code, route name, or customer name or code;
  - type chips: `R`, `S` and `⚡A`;
  - task chips, one per non-routable type: `OTC` and `COMPACTOR`. Every chip toggles visibility;
  - [Clear highlight], shown while a highlight or search is active.
- **Legend row**: every route code that appears in the visible range, as `▌CODE short-name`, sorted A, R, S and then by code. Clicking a code highlights it.
- **Highlight and search.**
  - Clicking a code (in the legend, a row or a chip) highlights that code on every date. Everything else dims to 18% opacity.
  - Clicking the same code again, or pressing Esc, clears the highlight.
  - Search dims everything that does not match. It covers routes (code, name, stop customers) and tasks (customer).
  - Highlight and search are exclusive: the last one used wins.
- **Week view**: 7 columns, Monday to Sunday, so rest days sit at the right. Each column has:
  - **Header**: "Wed 11 Nov".
    - Today (the op_date) gets a "Today" tag and an accent ring. Between 00:00 and the rollover the tag stays on the previous date and reads "Today · until {time}" (§9.1), so the night shift is still visible as live.
    - Past days get a lock.
    - Rest days get a rose tint, and a PH also gets a red tag with its name.
    - A summary line: "12 routes · 96 stops · 4 tasks · 1 paused".
    - Today's ops line, and the totals for today and past days.
  - **Tasks group**, at the top so that tasks are never buried under 10+ routes:
    - With 3 tasks or fewer, each task is one row.
    - With more than 3, the group collapses to one line, "▣ Tasks 5 · OTC 2 · COMPACTOR 3 · ○2 unclaimed ▸", which expands in place. It also expands automatically when a search or highlight matches a task in it.
    - **Task row (one line)**: grey fill, rounded pill, **no colour bar**; then the abbr tag (`OTC` / `COMPACTOR`), "↻" for a recurring task, the customer name (ellipsis) and the status (glyph + short word, §8.3) at the right. It never looks like a route container.
  - **Route rows (one line each)**: a 5 px colour bar, **CODE** (bold mono), the type tag (`R` / `S` / `⚡A`, with a dashed amber border for adhoc), the name (ellipsis, truncated first), and the status glyph + short word + count at the right (§8.3). Stops are not listed in the week view.
  - **Paused group**: "⏸ 3 regular routes paused (PH) ▸". Expanded rows offer [Run on PH] and [Move to work day…].
  - **Footer** (today and later): [+ Route] [+ Task].
- **Month view**: a 6 × 7 grid.
  - Each cell shows the date, "12 routes", a PH tag, and then **code chips** in day order. A chip is the code with a 4 px colour edge; adhoc chips are dashed with a lightning mark, and today and past chips carry a status dot.
  - After the code chips come "⏸3" for paused routes and **one task chip** "▣ 5". The task chip gets an amber dot if today has unclaimed tasks, or if a past day has incomplete or no-record tasks; its tooltip lists the tasks.
  - Clicking the date opens the **day drawer** (about 460 px), which renders the same column as the week view. Clicking a chip opens that route's drawer.
- **Route drawer**: §6.1.
- **Task drawer**: §6.8.
- **Dialogs**:
  - Scope
  - Copy to date
  - Edit route / schedule
  - Route create (one form per type)
  - Urgent pickup
  - Task create / edit
  - Result (visit)
  - Run exists
  - Customer in use / archive result
  - Assign driver

**Routes page.**
- A table with these columns: colour, code, type, name, schedule, start/end, stops, next date and today's status. A filter shows ended routes.
- The template editor: an ordered stop list (customer and stop note; routable type tags only), reordered by drag and drop, ↑ ↓ or move to # (the same `StopList` as the route drawer, §6.1). A change from a later date goes through [Change schedule from date…].
- Actions: [Change schedule from date…], [End], [Delete].

**Tasks page.**
- A table with these columns: type, customer, schedule ("Once Sat 15 Nov" / "Tue, Fri from 17 Nov"), end, next date, note and today's status.
- Filters: type, one-off or recurring, and active or ended.
- Actions: Edit, End, Delete.

**Customers page.**
- A searchable table with these columns: code, name, address, waste-type tags, routes (codes), tasks (types), and an archived filter.
- The form requires at least one waste-type chip.
- Actions: [Archive] (with a removal preview) and [Restore].

**Holidays page.** Per §6.10.

**Settings page.**
- **Waste types** (admin):
  - Columns: code, name, abbr, unit, weigh method (On site / Weighbridge), routable (read-only after create), recurring tasks, confirm-over, active, and drag order (the same dnd-kit sortable list as the route drawer).
  - There is no delete.
- **Trucks** (office): the vehicle list, a list of plates, each with an active toggle. Drivers pick their plate only from the active plates (R23).
- **Day rollover** (admin; read-only for office users): an hour picker from 00:00 to 06:00, default 04:00, with the hint "Work done before this hour counts for the previous day (night shifts). The calendar's Today, driver lists, claims, locks and the edit deadline all follow it. Set it between the end of the latest night shift and the start of the earliest morning shift: a day's jobs cannot be claimed before that hour." A change that would move today is refused with `ROLLOVER_SHIFTS_TODAY` and the message "Try again after {retry_after}" (R1).

**Users page** (admin).
- Columns: username, name, role, language, active, locked (any IP lock in force), and current jobs for drivers.
- Actions: [Reset password] (sets `must_change_password` and clears the login locks), deactivate (releases the driver's jobs).

### 9.3 Driver (mobile-first, at `/driver`; can be added to the home screen)
- **Ergonomics**: touch targets of at least 56 px and text of at least 18 px; primary buttons fixed at the bottom; no hover, no drag (drag-and-drop is an office feature only), no icon-only buttons.

**S0 Login.** The username is remembered. A large password field, a language toggle, and inline errors. A locked account sees "Try again at 07:52".

**S1 Today.**
- **Top bar**: the op_date (between 00:00 and the rollover: "Wed 11 Nov · night shift until {time}. Thu 12 Nov jobs appear at {time}", §9.1), the driver's name, and a sync pill: "Synced 10:14" / "2 unsent" / "Offline · data from 10:12".
- **My work**: a "Continue N1 3/8" card and one card per held task. Jobs assigned by the office show an "Assigned by office" tag.
- **Tabs**: [Routes (12)] [Tasks (4)].
  - **Route card** (72 px): colour bar, **CODE in 20 px mono**, type tag, name, "8 stops", the first 3 customers, the note and the status. A taken route is grey and cannot be tapped ("Chong 4/10").
  - **Task card**: the abbr badge (`OTC` / `COMPACTOR`), "↻" for a recurring task, the customer name and address, the note, the status, and "also on your route N1" where it applies.
- **Banners**: "New today" for new jobs. The "Not sent: show the office" list appears when it is not empty.

**S2 Route preview (= select).**
- Content: the code, name, note and a read-only stop list (seq, name, address).
- A truck-plate select from the office's active vehicle list (Settings), pre-filled with this phone's last plate when it is still active.
- A fixed 64 px button, [Confirm: I take this route].
  - If the driver holds another route, it reads [Switch to this route] and opens the sheet in §7.5.
  - Offline, it is disabled and reads "Needs signal".

**S2T Task preview.**
- Content: the type, customer, address, [Navigate] [Call], the note and the plate select.
- [Confirm: I take this task]. It works while the driver holds a route.

**S3 Run (route).**
- Header: code, progress "3 / 8", and the totals per type.
- Pending stops as large cards in seq order, with a NEW badge and "also on …" where they apply. Cards show only routable type tags (`weigh_types`), never OTC or COMPACTOR (§6.1).
- A collapsible Done list: ✓ or ✗, the weights, and a cloud icon while unsent.
- [Finish route] when pending = 0. Otherwise, in the overflow menu: [Leave route…] and [⇄ Switch route].

**S4 Result form** (a route stop, or a task):
- The customer name in large type, the address with [Navigate] (a Google Maps or Waze link) and [Call], the stop note and the customer note.
- **One field per weighable type**, rendered from the stop's `weigh_types` (route: the customer's registered routable types; task: the task's type). There is no way to add another type on site.
  - a label "REL (kg)";
  - `inputmode=decimal`, a 28 px font, "," accepted;
  - a [0] chip;
  - a value ≥ `confirm_over` asks "1,250.0 kg, correct?".
- A **Ticket no.** field per weighable type whose `weigh_method = weighbridge`. It is hidden for on-site types, which are all types by default.
- [Add photo]: the camera opens, and thumbnails appear, up to 5.
- [Signature]: a full-screen finger pad, with Clear and Save.
- An optional note.
- [Collected: save] in big green. For a route stop it then goes to the next stop; for a task, back to Today.
- [Not collected] opens a reason sheet: No waste / Closed / No access / Refused / Other….
- When the form is reopened from Done (today's jobs only): [Save correction] and [Undo].
- For a task, the overflow menu has [Give back] while the result is not yet saved.

**S5 Leave sheet.** "5 stops not done" with three choices: [Give back: another driver or the office can take them], [Mark all not collected…] (asks for a reason), [Cancel].

**S6 Route done.** Collected, missed and the totals per type, then [Back to Today].

**S7 Not sent.** Refused entries with the server's reason. Each one can be opened, edited and resent, or shown to the office.

**Tap counts:**
- start a route: 2 taps;
- each stop: typing the weight + 1 tap;
- a not-collected stop: 2 taps;
- switch route: 3 taps;
- take and complete a task: 2 taps + typing.

---

## 10 API

### 10.1 Conventions
- **Base path** `/api`. JSON in and out, UTF-8. A JSON body is at most 1 MB.
- **Success**: `{"ok":true,"data":…,"warnings":[{"code","message"}]}`.
- **Error**: `{"ok":false,"error":{"code","message","field","details"}}`. HTTP status codes:
  - 400 malformed request;
  - 401 not authenticated;
  - 403 role;
  - 404 not found;
  - 409 conflict;
  - 413 file too large;
  - 422 rule violation;
  - 423 locked;
  - 503 `DATA_CORRUPT` (a data file does not decode; nothing is written, R36) or `CLOCK_BEHIND_FREEZE` (the clock is behind the frozen days; nothing is written, R13).
- **Auth**: `Authorization: Bearer <token>` on every endpoint except `POST /api/login` and `GET /api/health`.
- **Path parameters**:
  - dates are `YYYY-MM-DD`;
  - jobs are `r<route_id>` or `t<task_id>`;
  - runs are `/runs/{date}/{job}`.
- **Headers**: JSON responses send `Cache-Control: no-store`.

### 10.2 Auth and me
```
POST /api/login {"username":"ali","password":"…"}
  -> {"token":"eyJ1aWQiOjMsInR2IjoyLCJleHAiOjE3NjU…","user":{"id":3,"username":"ali","name":"Ali","role":"driver","lang":"en","must_change_password":false}}
  | 401 BAD_CREDENTIALS | 423 ACCOUNT_LOCKED {"until":"2026-11-11T07:52:00+08:00"}
GET   /api/me                      -> user
PATCH /api/me {"lang":"zh"}        -> user
POST  /api/me/password {"old":"…","new":"…"}  -> {"token":"…"}   (bumps token_version, returns a fresh token)
POST  /api/me/logout-all           -> 204 (bumps token_version)
GET   /api/health                  -> {"ok":true}
```

### 10.3 Meta
```
GET /api/meta ->
{"today":"2026-11-11","now":"2026-11-11T07:40:02+08:00","timezone":"Asia/Singapore","next_work_day":"2026-11-12",
 "rollover_hour":4,"day_ends_at":"2026-11-12T04:00:00+08:00",
 "me":{"id":2,"username":"mei","name":"Mei","role":"office","lang":"zh"},
 "waste_types":[{"code":"REL","name":"REL","abbr":"REL","unit":"kg","weigh_method":"on_site","routable":true,"recurring_tasks":false,"confirm_over":1000,"active":true}, …],
 "trucks":["SBA1234X","GBA1234X"],
 "config":{"max_photos":5,"driver_edit_grace_hours":8}}
```
- `today` is the op_date (R1). At `now` = 2026-11-12T03:59:00+08:00 the response still has `"today":"2026-11-11"` and `"day_ends_at":"2026-11-12T04:00:00+08:00"`.

### 10.4 Calendar (office)
```
GET /api/calendar?view=week|month&anchor=2026-11-11 ->
{"from":"2026-11-09","to":"2026-11-15","today":"2026-11-11","prev_anchor":"2026-11-02","next_anchor":"2026-11-16",
 "missing_holiday_years":[2027],
 "days":[{"date":"2026-11-11","dow":3,"class":"work","holiday":null,"past":false,"in_month":true,
          "can_create":["regular","adhoc","task"],
          "totals":{"REL":2410.0,"OTC":300.0},"provisional":true,
          "ops":{"not_started":3,"active":6,"open":1,"done":2,"incomplete":0,"no_record":0}}],
 "routes":[RouteOccurrence…],
 "tasks":[TaskOccurrence…],
 "customers":{"12":{"id":12,"code":"C0012","name":"ABC Restaurant","address":"12 Jalan Besar","waste_types":["REL","OTC"],"active":true}}}
```
- `ops` is present only for today and past days.
- `customers` covers every customer referenced in the range, archived ones included.
- Occurrences are already sorted per §5.8.

### 10.5 Routes and containers (office)
```
GET    /api/routes?ended=0      -> [{"id","code","color","type","name","days"|"sun","ph"|"date","start","end","stop_count","next_date","today_status","rev"}]
GET    /api/routes/{id}         -> Route + "overrides":[override dated >= today]
POST   /api/routes
  {"type":"regular","code":"N1","color":null,"name":"North 1","note":"","start":"2026-11-16","end":null,"days":[1,3,5],"stops":[{"customer_id":12,"note":"3 bins"}]}
  {"type":"special","code":"S1","name":"Sunday Market","start":"2026-11-15","sun":true,"ph":true,"stops":[…]}
  {"type":"special","code":"S2","name":"PH run","date":"2026-12-25","stops":[…]}
  {"type":"adhoc","code":"A1","name":"Adhoc 12 Nov","note":"Call 11 Nov: overflow","date":"2026-11-12","stops":[…]}
  -> 201 Route (color auto-assigned when null) ; warning EMPTY_ROUTE
PATCH  /api/routes/{id} {"rev":4,"code"?,"color"?,"name"?,"note"?,"days"?,"sun"?,"ph"?,"start"?,"end"?,"date"?,"stops"?,"release_run"?} -> Route
       (stops = the full template list)
POST   /api/routes/{id}/change-schedule {"rev":4,"from":"2026-12-01","days":[2,4],"stops"?:[…]} -> {"ended":Route,"created":Route}
       (schedule fields and stops are optional; the "following" save of R12 sends only stops)
DELETE /api/routes/{id}?rev=4[&release_run=1] -> 204
PUT    /api/routes/{id}/dates/{date}
       {"rev":4,"scope":"this"|"following","stops":[{"customer_id":40,"note":""}]?,"note":"use small truck"?,"cancelled":false?,"release_run":false?}
       -> {"route":Route,"occurrence":RouteOccurrence}   (scope ignored for one-offs; cancelled only with scope "this";
          when "following" splits the route (R12/R14), "route" is the new route and "ended" carries the old one)
DELETE /api/routes/{id}/dates/{date}?rev=4 -> reset to route default (deletes the override)
POST   /api/routes/{id}/dates/{date}/copy {"rev":4,"to":"2026-12-26","code":"N1-26","name":"…","skip_source":false,"release_run"?:false} -> 201 {"created":Route}
       (release_run only with skip_source = true and src = today, R26)
GET    /api/routes/suggest-code?type=adhoc|special|copy&date=2026-11-12[&route_id=5]
       -> {"code":"A2","class":"work","holiday":null,"type":"adhoc"|"special"|"regular"}
       (type=copy applies the R5 copy rule and the R15 type rule for route_id; codes in use are skipped)
```

### 10.6 Tasks (office)
```
GET    /api/tasks?type=OTC&kind=one_off|recurring&ended=0 -> [{"id","waste_type","customer":{id,code,name},"date"|"start","end","days","note","next_date","today_status","rev"}]
GET    /api/tasks/{id}          -> Task + "overrides":[…]
POST   /api/tasks {"waste_type":"OTC","customer_id":12,"date":"2026-11-15","note":"Old furniture"}
POST   /api/tasks {"waste_type":"COMPACTOR","customer_id":40,"start":"2026-11-17","end":null,"days":[2,5],"note":""}
       -> 201 Task | 422 TYPE_ROUTABLE | CUSTOMER_LACKS_TYPE | RECURRING_NOT_ALLOWED | PAST_DATE_LOCKED
PATCH  /api/tasks/{id} {"rev":2,"note"?,"date"?,"days"?,"start"?,"end"?,"release_run"?} -> Task | 422 TASK_FIELD_IMMUTABLE
DELETE /api/tasks/{id}?rev=2[&release_run=1] -> 204
PUT    /api/tasks/{id}/dates/{date} {"rev":2,"cancelled":true,"note":"Closed","release_run":false} -> {"task":Task,"occurrence":TaskOccurrence}
DELETE /api/tasks/{id}/dates/{date}?rev=2 -> reset
POST   /api/tasks/{id}/dates/{date}/copy {"rev":2,"to":"2026-11-21","skip_source":true,"release_run"?:false} -> 201 {"created":Task}
       (release_run only with skip_source = true and src = today, R26)
```

### 10.7 Customers, holidays, waste types, trucks, users, drivers
```
GET   /api/customers?q=abc&archived=0&routable=1&type=OTC -> [Customer + "routes":["N1","S1"] + "tasks":["OTC"]]   (codes of routes and task types that use it from today on)
GET   /api/customers/{id}      -> Customer + "routes":[{"route_id","code","name","type"}] + "tasks":[{"task_id","waste_type","schedule"}]
POST  /api/customers {"code"?,"name","address","phone","note","waste_types":["REL"]} -> 201 Customer
PATCH /api/customers/{id} {"name"?,"address"?,"phone"?,"note"?,"waste_types"?,"detach"?,"release_run"?}
      -> Customer (+ "removed":[…] when detach) | 409 CUSTOMER_IN_USE {"routes":[…],"tasks":[…]}
POST  /api/customers/{id}/archive {"release_run"?} -> {"removed":[{"kind":"route","route_id":5,"code":"N1","where":"template"|"override"|"one-off","date":null},{"kind":"task","task_id":3,"action":"ended"|"deleted"}]}
POST  /api/customers/{id}/restore -> Customer

GET    /api/holidays?year=2026 -> [{"date","name"}]
PUT    /api/holidays/{date} {"name":"Deepavali","release_run"?} -> upsert
DELETE /api/holidays/{date}[?release_run=1]
       -> 409 HOLIDAY_CONFLICT {"routes":[{"id","code","name","type","date"}]} | 409 RUN_EXISTS | 422 PAST_DATE_LOCKED

GET   /api/waste-types
POST  /api/waste-types {"code":"GLS","name":"Glass","abbr":"GLS","unit":"kg","weigh_method":"on_site","routable":false,"recurring_tasks":false,"confirm_over":null}   (admin)
PATCH /api/waste-types/{code} {"name"?,"abbr"?,"weigh_method"?,"recurring_tasks"?,"confirm_over"?,"active"?}            (admin) | 409 WASTE_TYPE_IN_USE
PUT   /api/waste-types/order {"codes":["REL","OTC","COMPACTOR"]}                                                          (admin)

GET   /api/trucks -> [{"plate","active"}]
PUT   /api/trucks {"trucks":[{"plate":"SBA1234X","active":true}]}            (office, admin)

GET   /api/settings -> {"rollover_hour":4}                                   (office, admin)
PATCH /api/settings {"rollover_hour":4}                                      (admin)
      -> {"rollover_hour":4} | 422 VALIDATION (not an integer 0–6) | 422 ROLLOVER_SHIFTS_TODAY {"today","would_be","retry_after"}   (R1)

GET   /api/users                (admin) -> [{"id","username","name","role","lang","active","locked_until"}]   (locked_until = the latest per-IP lock still in force, or null)
POST  /api/users {"username","name","role","lang","password"}  (admin) -> 201 | 422 USERNAME_TAKEN | PASSWORD_TOO_SHORT
PATCH /api/users/{id} {"name"?,"role"?,"lang"?,"active"?,"password"?}  (admin; password = reset -> must_change_password; active=false releases jobs)
GET   /api/drivers              (office) -> [{"id","name","active","route_job":{"date","job","code","pending"}|null,"task_jobs":[{"job","customer"}]}]
      (route_job and task_jobs follow R25: jobs held today only. The Users page "current jobs" uses the same rule)
```

### 10.8 Runs (office)
```
GET  /api/runs/{date}/{job}                 -> JobDetail + "holds":[…] + full visits with history
POST /api/runs/{date}/{job}/release {"mark_missed":false} | {"mark_missed":true,"reason":"not_visited","note":"customer called off"}
     -> {"result":"not_started"|"open"|"done"}   (the run is always kept. With mark_missed = false the job must have a holder.
        With mark_missed = true this is Close out: it also works on a job with no run, creating a holder-less run, R21)
POST /api/runs/{date}/{job}/assign {"driver_id":7,"switch":false}
     -> {"run":RunSummary,"gave_back":null|{"job":"r9","result":"open"|"done"|"not_started"}} | 409 DRIVER_HAS_ACTIVE_RUN | 422 NOT_TODAY | NOT_RUNNABLE
PUT  /api/runs/{date}/{job}/stops/{customer_id}
     {"op_id":"…","base_rev":1,"outcome":"collected","weights":{"REL":118.0},"tickets":{},"photos":["0b6e….jpg"],"signature":null,
      "reason":null,"note":"","why":"weighbridge recheck","driver_id":null}
     -> {"visit":Visit,"run":RunSummary} | 422 WHY_REQUIRED | 409 VISIT_CHANGED   (creates a holder-less run if none; dates <= today)
```

### 10.9 Driver (role driver)
```
GET /api/driver/today ->
{"today":"2026-11-11","now":"2026-11-11T07:40:02+08:00","me":{"id":3,"name":"Ali","lang":"en"},
 "my_route":null|{"date":"2026-11-11","job":"r9","code":"W2","name":"West 2","pending":5,"total":8,"vehicle_no":"GBA1234X","assigned":false},
 "my_tasks":[{"date":"2026-11-11","job":"t6","waste_type":"OTC","customer":"ABC Restaurant","vehicle_no":null,"assigned":true}],
 "waste_types":[…active…], "trucks":["SBA1234X","GBA1234X"],
 "routes":[{"job":"r5","date":"2026-11-11","code":"N1","color":1,"type":"regular","name":"North 1","note":"","stops":8,
            "first_customers":["ABC Restaurant","Kopi Tiam 88","Sin Hup"],"status":"open","driver":null,"left_by":"Bala",
            "collected":3,"missed":0,"pending":5,"can_take":true}],
 "tasks":[{"job":"t6","date":"2026-11-11","waste_type":"OTC","recurring":false,"note":"Old furniture",
           "customer":{"id":12,"name":"ABC Restaurant","address":"12 Jalan Besar"},
           "status":"active","driver":{"id":3,"name":"Ali"},"can_take":false,"also_on":[{"job":"r5","code":"N1"}]}]}
```
- `today` is the op_date (R1): at 02:30 on Thu 12 Nov it is still `2026-11-11`, and the lists are Wednesday's.
- The lists contain today's scheduled jobs that have at least 1 stop, or a run.
- Order: open, not_started, active, done; then by code (routes) or by customer (tasks).

```
GET /api/driver/runs/{date}/{job} -> JobDetail (same shape before a claim and during the run):
{"date":"2026-11-11","job":"r5","kind":"route","code":"N1","color":1,"type":"regular","name":"North 1","note":"",
 "waste_type":null,                       // task: "OTC"
 "status":"active","holder":{"id":3,"name":"Ali"},"mine":true,"vehicle_no":"GBA1234X",
 "progress":{"collected":3,"missed":0,"pending":5,"total":8},"totals":{"REL":420.5},
 "stops":[{"seq":1,"on_plan":true,"stop_note":"3 bins",
   "customer":{"id":12,"code":"C0012","name":"ABC Restaurant","address":"12 Jalan Besar","phone":"+65 9123 4567","note":"bins at back lane"},
   "weigh_types":["REL"],"ticket_types":[],
   "also_on":[{"job":"t6","label":"OTC task","outcome":null}],
   "visit":null|{"outcome","weights","tickets","photos","signature","reason","note","driver_id","rev","captured_at","flags"}}]}

POST /api/driver/runs/{date}/{job}/claim {"vehicle_no":"GBA1234X","switch":false}
  -> 201 (created) | 200 (picked up / already mine): {"run":JobDetail,"left":null|{"job":"r9","result":"open"|"done"|"not_started"}}
  -> 409 RUN_TAKEN {"driver":"Chong","since":"…","collected":4,"total":10}
  -> 409 DRIVER_HAS_ACTIVE_RUN {"job":"r9","code":"W2","pending":5}      (route jobs only; resend with "switch":true)
  -> 422 NOT_TODAY | NOT_RUNNABLE | VEHICLE_REQUIRED | VEHICLE_UNKNOWN | 404 NOT_FOUND

PUT /api/driver/runs/{date}/{job}/stops/{customer_id}
  {"op_id":"3f0c…","base_rev":0,"outcome":"collected","weights":{"REL":120.5},"tickets":{},
   "photos":["0b6e1c2a-7f3d-4c55-9a1e-2b9d6a0c31f1.jpg"],"signature":"5d2a….png","reason":null,"note":"","captured_at":"2026-11-11T09:14:03+08:00"}
  {"op_id":"…","base_rev":0,"outcome":"missed","weights":{},"tickets":{},"photos":[],"signature":null,"reason":"closed","note":"shutter down","captured_at":"…"}
  {"op_id":"…","base_rev":1,"outcome":null,"captured_at":"…"}                                   (undo)
  -> 200 {"visit":Visit,"progress":{…},"totals":{…},"replay":false} ; warnings OFF_PLAN, LATE
  -> 409 VISIT_CHANGED {"visit":current} | 409 NOT_HOLDER
  -> 422 NOT_ON_JOB | TYPE_NOT_ALLOWED | WEIGHT_INVALID {"field":"weights.REL"} | WEIGHT_REQUIRED | TICKET_REQUIRED | REASON_REQUIRED | FILE_MISSING | EDIT_WINDOW_CLOSED

POST /api/driver/runs/{date}/{job}/release {"mark_missed":false} | {"mark_missed":true,"reason":"other","note":"truck breakdown"}
  -> {"result":"not_started"|"open"|"done"} | 409 NOT_HOLDER | 422 NOT_TODAY   (Finish = the same call; mark_missed is ignored when pending = 0; the run is kept;
     a past run is closed out only by the office, R24)
```
- On a route stop, the `customer` object carries no waste-type list. The client renders `weigh_types` only (the customer's active routable types), so OTC and COMPACTOR never appear on a route stop card (§6.1). A non-routable task for the same customer that day shows only through `also_on`.

### 10.10 Files (driver, office, admin)
```
PUT /api/files/{uuid}.jpg   (Content-Type: image/jpeg, raw body <= 2 MB)  -> 201 {"path":"files/0b/….jpg"} | 200 (already stored)
PUT /api/files/{uuid}.png   (Content-Type: image/png,  raw body <= 300 KB)
    -> 422 FILE_INVALID | 413 FILE_TOO_LARGE
GET /api/files/{uuid}.{jpg|png} -> bytes (Cache-Control: private, max-age=31536000, immutable)
```

### 10.11 Error codes (full list; `src/i18n/zh.ts` and `en.ts` map each one to a message)
| Group | Codes |
|---|---|
| Generic | `VALIDATION`, `NOT_FOUND`, `UNAUTHORIZED`, `FORBIDDEN` |
| Accounts | `BAD_CREDENTIALS`, `ACCOUNT_LOCKED`, `PASSWORD_CHANGE_REQUIRED`, `PASSWORD_TOO_SHORT`, `USERNAME_TAKEN`, `LAST_ADMIN` |
| Plan | `TYPE_IMMUTABLE`, `WEEKDAY_NOT_ALLOWED`, `DAY_CLASS_VIOLATION`, `PAST_DATE_LOCKED`, `NOT_AN_OCCURRENCE`, `DUPLICATE_STOP`, `CUSTOMER_INACTIVE`, `CUSTOMER_NOT_ROUTABLE`, `CODE_IN_USE`, `STALE_REVISION`, `HOLIDAY_CONFLICT`, `RUN_EXISTS` |
| Master data and settings | `WASTE_TYPES_REQUIRED`, `UNKNOWN_WASTE_TYPE`, `WASTE_TYPE_IN_USE`, `CUSTOMER_IN_USE`, `ROLLOVER_SHIFTS_TODAY` |
| Tasks | `TYPE_ROUTABLE`, `CUSTOMER_LACKS_TYPE`, `RECURRING_NOT_ALLOWED`, `TASK_FIELD_IMMUTABLE` |
| Runs | `NOT_TODAY`, `NOT_RUNNABLE`, `RUN_TAKEN`, `DRIVER_HAS_ACTIVE_RUN`, `NOT_HOLDER`, `VEHICLE_REQUIRED`, `VEHICLE_UNKNOWN` |
| Visits | `VISIT_CHANGED`, `NOT_ON_JOB`, `TYPE_NOT_ALLOWED`, `WEIGHT_INVALID`, `WEIGHT_REQUIRED`, `TICKET_REQUIRED`, `REASON_REQUIRED`, `WHY_REQUIRED`, `EDIT_WINDOW_CLOSED`, `FILE_MISSING` |
| Files | `FILE_INVALID`, `FILE_TOO_LARGE` |
| Storage | `DATA_CORRUPT`, `CLOCK_BEHIND_FREEZE` |
| Warnings (not errors) | `EMPTY_ROUTE`, `OFF_PLAN`, `LATE` |

---

## 11 Tech stack, folder layout, run scripts, deployment

### 11.1 Stack
- **Backend**:
  - PHP 8.3, with no framework and no Composer. Production runs it under PHP-FPM (Ubuntu 24.04's `php8.3-fpm`); local development uses the built-in server `php -S`. The same code runs under both.
  - Only built-in functions are used: `json`, `hash`/`hash_hmac`, `random_bytes`, `password_hash`/`password_verify`, `flock`. No `mbstring`; text lengths are checked with `preg_match('/^.{1,60}$/u')`.
  - One front controller.
- **Frontend**:
  - React 18 + Vite + TypeScript.
  - `react-router-dom`: `/` for the office, `/driver` as a lazy-loaded chunk.
  - `@tanstack/react-query`: one query per view and anchor, invalidated after writes. Plan writes are never optimistic.
  - `idb-keyval` for the outbox.
  - `vite-plugin-pwa` for the driver app shell.
  - `@dnd-kit/core` + `@dnd-kit/sortable` (with `@dnd-kit/utilities` for the CSS transform) for drag-and-drop reordering of stops in the route drawer and the Routes template editor, and of waste types in Settings (§6.1). It is small, has no other dependencies, and supports mouse, touch and keyboard with screen-reader announcements. The sensors are `useSensors(useSensor(MouseSensor, {activationConstraint: {distance: 5}}), useSensor(TouchSensor, {activationConstraint: {delay: 200, tolerance: 5}}), useSensor(KeyboardSensor, {coordinateGetter: sortableKeyboardCoordinates}))`. `PointerSensor` is not used, because it also handles touch and would start a drag after 5 px, before the 200 ms hold. The ⠿ handle has `touch-action: manipulation`. The office bundle only; the driver chunk never imports it. ↑ ↓ and "move to #" stay as alternatives.
  - Plain CSS tokens.
  - No calendar library and no date library. Dates stay `YYYY-MM-DD` strings; the client never calls `new Date('YYYY-MM-DD')` for rules.
- **i18n**: `src/i18n/{zh,en}.ts` dictionaries with a tiny `t(key, vars)`. A test checks that both have the same keys.
- **HTTPS (production)**: Caddy from the official Caddy apt repository on the Linux VPS, with automatic Let's Encrypt certificates and renewal. It serves the built app as static files and passes `/api/*` to PHP-FPM over a Unix socket (`php_fastcgi`). Local development on Windows uses plain HTTP (§11.3).
- **Server OS**: Ubuntu 24.04 LTS (assumed by `deploy/install.sh`), systemd for auto-start, `ufw` firewall.

### 11.2 Folder layout
```
/backend
  bootstrap.php           loads config, date_default_timezone_set(config.tz), umask(0027); required first by
                          public/index.php and every tools/*.php (R36)
  public/index.php        router (method+path table), JSON envelope, request body read before the lock (R35),
                          auth + role check, R13 freeze call,
                          audit line, security headers, SPA fallback for local php -S only (an existing
                          file under public/app -> return false so php -S serves it; any other non-/api path ->
                          readfile(public/app/index.html)). In production Caddy serves public/app and only /api/* reaches PHP.
  public/app/             vite build output (git-ignored; created empty by start-backend.bat and install.sh)
  src/Clock.php           now (config.fake_now), opDate(now, rollover_hour), dayStart/dayEnd, editDeadline (R1, R28)
  src/Store.php           Store, Tx interfaces
  src/FileStore.php       flock, cached docs, atomic write + retry, .bak, first-start seed
  src/Blobs.php           photo/signature files
  src/Schedule.php        dayClass, routesOn, tasksOn, effectiveStops, freeze (pure)
  src/Plan.php            routes, overrides, copy, change-schedule, tasks, customers (+detach), holidays,
                          waste types, trucks, settings (rollover_hour); validation R3–R20; R26 check
  src/Runs.php            status/counts, claim, release, assign, visit write, revisions (R21–R32; pure functions
                          of (plan, day, users, today, now, principal))
  src/Auth.php            login, token sign/verify, password, lockout, roles (R33–R34)
  src/Http.php            request parsing, ApiError(code, http, field, details)
  seed/holidays-sg.json   {"2026":[…],"2027":[…]} grouped by year (2027 filled in M2 from MOM; imported per R16 seeded_years)
  tools/backup.php        backup.php <dir> [--keep 30]: backs up the whole data dir except .lock and temp files
                          (plan, users, days, secret.key, audit/, *.bak) to a dated folder named in config.tz. Everything
                          but files/ is copied under the same flock; files/ (immutable) is done outside the lock,
                          and each photo is hard-linked (link()) from the newest earlier dated folder when it is
                          already there, so it is stored once on disk; only new photos are copied (copy() if link()
                          fails). Exits non-zero with a log line when the disk has under 15% free. Deletes dated
                          folders older than --keep days.
  tools/init.php          first start from the command line (seed + admin password printed), used by install.sh
  config.php              tz, data_dir, token_days=30, driver_edit_grace_hours=8, max_photos=5,
                          max_jpeg_bytes=2000000, max_png_bytes=300000, fake_now=null
                          (the rollover hour is not here: it is an admin setting in plan.json, R1).
                          Merges the git-ignored backend/config.local.php when present, then getenv('WMS_DATA_DIR'),
                          so a server or a demo never edits a tracked file (git pull stays clean). fake_now is
                          honoured only with a .demo marker in the data dir (R1)
  data/                   git-ignored (see §4.3)
  tests/run.php  tests/cases/*.json  tests/api_smoke.php  tests/race.php  tests/backup_test.php
  config.local.php        git-ignored local overrides (data_dir, fake_now for demos on a .demo copy)
/frontend
  index.html  package.json  vite.config.ts  tsconfig.json
  src/main.tsx  src/App.tsx           routes: /login /, /routes, /tasks, /customers, /holidays, /settings, /users, /driver/*
  src/api.ts                          the ONLY file that knows the backend JSON (types, fetch, token, error mapping)
  src/i18n/  index.ts zh.ts en.ts
  src/ui/    tokens.css palette.ts Dialog.tsx Drawer.tsx Chip.tsx StatusGlyph.tsx photo.ts (resize; driver and office) uuid.ts (getRandomValues)
  src/office/ CalendarPage (TopBar, FilterBar, Legend, WeekView, MonthView, DayColumn, RouteRow, TaskRow,
              RouteDrawer, StopList (dnd-kit sortable + ↑ ↓ + move to #; also used by RoutesPage), TaskDrawer,
              ScopeDialog, CopyDialog, RouteForm, UrgentDialog, TaskDialog,
              ResultDialog, RunExistsDialog, AssignDialog), RoutesPage, TasksPage, CustomersPage,
              HolidaysPage, SettingsPage, UsersPage, LoginPage
  src/driver/ DriverApp, Login, Today, RoutePreview, TaskPreview, Run, ResultForm, LeaveSheet, Done, NotSent,
              outbox.ts, cache.ts, SignaturePad.tsx
/deploy                   production on the Linux VPS (§11.4)
  install.sh              one-shot, idempotent setup of a fresh Ubuntu 24.04 LTS server
  update.sh               backup, git pull, build the frontend beside the live one and swap it in, reload PHP-FPM
  Caddyfile               template; install.sh writes it to /etc/caddy/Caddyfile with the domain filled in
  php-fpm-wms.conf        PHP-FPM pool (user wms, Unix socket) -> /etc/php/8.3/fpm/pool.d/wms.conf
  wms-backup.service  wms-backup.timer   nightly backup -> /etc/systemd/system/
start-backend.bat  start-frontend.bat  start.bat  build.bat      local development and trials on Windows (§11.3)
.gitattributes            *.sh, deploy/* and *.php text eol=lf; *.bat text eol=crlf (the repo is edited on Windows
                          and cloned on Linux: a CRLF install.sh would fail with "bash\r: not found")
README.md                 local dev, VPS install, update, backup and restore
```

### 11.3 Run scripts (Windows .bat, local development and trials)
These scripts are for the user's Windows PC only: development, demos and trials on the office network. Production is the Linux VPS (§11.4).

`start-backend.bat`: the API, plus the built app if one exists, on 0.0.0.0:8080.
```bat
@echo off
cd /d %~dp0
if not exist backend\public\app mkdir backend\public\app
:loop
php -S 0.0.0.0:8080 -t backend\public\app backend\public\index.php
echo Backend stopped, restarting in 2 s...
timeout /t 2 /nobreak >nul
goto loop
```
The loop restarts the local server after a crash; it runs in a console window opened by `start.bat`. (In production systemd restarts PHP-FPM and Caddy instead.) The first start prints the generated admin password (R33).
`start-frontend.bat`: the dev server on 0.0.0.0:5173, with `/api` proxied to 127.0.0.1:8080.
```bat
@echo off
cd /d %~dp0frontend
if not exist node_modules call npm install
call npm run dev -- --host 0.0.0.0 --port 5173
```
`start.bat`: both, in separate windows.
```bat
@echo off
cd /d %~dp0
start "WMS backend" cmd /k start-backend.bat
start "WMS frontend" cmd /k start-frontend.bat
```
`build.bat`: a build of the frontend into `backend\public\app`. After it, `start-backend.bat` alone serves the whole app for a local trial at `http://<pc-ip>:8080/` (office at `/`, drivers at `/driver`).
```bat
@echo off
cd /d %~dp0frontend
if not exist node_modules call npm install
call npm run build
```
A local backup, when wanted, is `php backend\tools\backup.php <folder>` run by hand. Production backups run on the VPS (§11.4).

`vite.config.ts` settings:
- `server: {host: '0.0.0.0', port: 5173, proxy: {'/api': 'http://127.0.0.1:8080'}}`
- `build: {outDir: '../backend/public/app', emptyOutDir: true}`
- `VitePWA({registerType: 'autoUpdate', manifest: {name, short_name, icons, start_url: '/driver', scope: '/'}, workbox: {navigateFallback: '/index.html', navigateFallbackDenylist: [/^\/api\//]}})`. `/api` is never cached. `start_url: '/driver'` makes a driver's home-screen icon open the driver app, not the office app at `/`. `App.tsx` also redirects `/` to `/driver` after login when the user's role is driver.

**Local development notes (Windows).**
- Run `start.bat` and open `http://<pc-ip>:5173` on a desktop. Allow ports 5173 and 8080 in Windows Firewall for Private networks.
- Phones on the same Wi-Fi can try the driver screens at `http://<pc-ip>:5173/driver`. The service worker (offline app shell) and a reliable "Add to Home screen" need HTTPS, so phone tests from M6 on and the airplane-mode test (M8) use the VPS at `https://<domain>/driver` (M1b).
- `php -S` is single-threaded, which is fine for a few local users. It is not used in production.
- A copy of the VPS data (a backup folder, §11.4) can be put into `backend\data` to try real data locally.

### 11.4 Production deployment (Linux VPS)
**Shape.** One small cloud VPS running Ubuntu 24.04 LTS (provider and size: §15 Q3):

| Part | What it does |
|---|---|
| Caddy (`caddy.service`, from the official Caddy apt repository) | listens on 80 and 443, gets and renews the Let's Encrypt certificate by itself, redirects HTTP to HTTPS, serves the built app from `/opt/wms/backend/public/app`, and passes `/api/*` to PHP-FPM |
| PHP 8.3-FPM (`php8.3-fpm.service`, pool `wms`) | runs `backend/public/index.php` as the service user `wms` on a Unix socket; never listens on a TCP port |
| `/opt/wms` | the git clone of the repo. Code is owned by root and read-only for `wms`; only `backend/data` (0750, owner `wms`) and `/var/backups/wms` are writable by `wms` |
| systemd | starts Caddy and PHP-FPM at boot and restarts them on failure (drop-ins `Restart=on-failure`, `RestartSec=2s`); runs `wms-backup.timer` nightly |
| `ufw` | allows only SSH, 80 and 443 |

**`deploy/Caddyfile`** (template; install.sh replaces `__WMS_DOMAIN__` and writes `/etc/caddy/Caddyfile`):
```
__WMS_DOMAIN__ {
  encode gzip
  request_body {
    max_size 3MB
  }
  header {
    Strict-Transport-Security "max-age=31536000"
    X-Content-Type-Options "nosniff"
    X-Frame-Options "DENY"
    Referrer-Policy "same-origin"
    Content-Security-Policy "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; connect-src 'self'"
  }
  handle /api/* {
    root * /opt/wms/backend/public
    php_fastcgi unix//run/php/wms.sock {
      request_buffers 3MB
      capture_stderr
    }
  }
  handle /assets/* {
    root * /opt/wms/backend/public/app
    file_server
  }
  handle {
    root * /opt/wms/backend/public/app
    try_files {path} /index.html
    file_server
  }
}
```
- `request_body max_size 3MB` (just above the 2 MB photo cap) refuses a huge body before it reaches PHP.
- `request_buffers 3MB` makes Caddy receive the whole body from a slow 4G phone before it passes it to PHP-FPM at socket speed, so a photo upload never ties up an FPM worker or the 30 s `request_terminate_timeout` (R35, R36).
- `capture_stderr` writes PHP warnings and fatal errors (sent by FPM on the FastCGI stderr stream) to Caddy's log, so a production 500 is visible in `journalctl -u caddy`.
- `handle /assets/*` serves the hashed build files with no SPA fallback: a missing chunk returns 404, never `index.html` with the wrong MIME type.
- The `header` block puts the security headers on every response, static files included.
- Every `/api/*` path falls through to `index.php` (php_fastcgi's default `try_files`). The router reads `REQUEST_URI`, which both `php -S` and Caddy set to the original path, so the same router works locally and in production.
- `try_files … /index.html` is the SPA fallback for `/driver/...` and the office routes; `backend/data` is outside both roots and is never served.

**`deploy/php-fpm-wms.conf`** (the complete pool file):
```ini
[wms]
user = wms
group = wms
listen = /run/php/wms.sock
listen.owner = caddy
listen.group = caddy
listen.mode = 0660
pm = dynamic
pm.max_children = 8
pm.start_servers = 2
pm.min_spare_servers = 1
pm.max_spare_servers = 3
request_terminate_timeout = 30s
php_admin_value[memory_limit] = 128M
php_admin_value[date.timezone] = Asia/Singapore
php_admin_flag[display_errors] = off
php_admin_flag[log_errors] = on
```
`pm = dynamic` needs the three `pm.*_servers` values, or `php-fpm8.3 -t` fails. Several workers run at once; the global flock serialises them (R36).

**`deploy/install.sh`** (one shot, idempotent; Ubuntu 24.04 LTS assumed). Usage, after the domain's DNS A record points at the VPS:
```bash
sudo git clone <repo-url> /opt/wms
cd /opt/wms
sudo WMS_DOMAIN=wms.example.com.sg bash deploy/install.sh
```
(`bash deploy/install.sh` works even when the execute bit was lost on the way through a Windows checkout.)
Before running it (also in the README and M1b):
- **Repo access**: for a private repo, add a read-only deploy key in `/root/.ssh` and clone over SSH; `update.sh` pulls with the same key.
- **Provider firewall**: open 80/tcp, 443/tcp and 443/udp in the provider's firewall or security group as well (AWS Lightsail, for example, opens only 22 and 80 by default); `ufw` alone is not enough.
- **DNS**: the A record must be DNS-only (for example Cloudflare's grey cloud, not the orange proxy). Behind a proxy every client would share a few IP addresses, and the per-IP login lockout (R34) would lock a username for everyone.
What it does, in order (`set -euo pipefail`; it stops with a clear message on the first failure):
1. **Checks**: running as root, Ubuntu 24.04, `WMS_DOMAIN` set, the repo at `/opt/wms`. It warns (does not stop) when `WMS_DOMAIN` does not resolve to this server's public IP, because Let's Encrypt would fail.
2. **System**: `timedatectl set-timezone Asia/Singapore` (log times and the backup timer in local time; the app itself always uses `config.tz`). Adds a 1 GB swap file when the server has under 2 GB RAM, so the frontend build does not run out of memory. Leaves Ubuntu's unattended security upgrades on.
3. **Packages**: `apt-get install -y php8.3-fpm php8.3-cli git ufw curl`, then Caddy from its official apt repository (`caddy` package, which brings `caddy.service`) and Node.js from NodeSource's apt repository, at the major pinned in `frontend/.nvmrc`. Ubuntu's own `nodejs` (18) is end-of-life and too old for current Vite tooling, so it is not used. `package.json` `engines` and `.nvmrc` pin the same Node major as the Windows PC, and `.npmrc` sets `engine-strict=true`, so both machines fail the same way on a mismatch.
4. **Service user**: `useradd --system --home-dir /opt/wms --shell /usr/sbin/nologin wms` (skipped when it exists).
5. **Permissions**: code owned by root; `install -d -o wms -g wms -m 0750 /opt/wms/backend/data /var/backups/wms`; existing files under `backend/data` are `chown -R wms:wms`. `secret.key` and the seed files end up 0640 through `umask(0027)` in `bootstrap.php`, which the CLI tools run too (R36).
6. **Frontend build**: `npm ci && npm run build` in `frontend/` into `backend/public/app` (readable by Caddy).
7. **Config files**: writes `/etc/caddy/Caddyfile` from the template, `/etc/php/8.3/fpm/pool.d/wms.conf`, the systemd drop-ins `/etc/systemd/system/{caddy,php8.3-fpm}.service.d/restart.conf`, and `/etc/systemd/system/wms-backup.{service,timer}`. Then `caddy validate`, `php-fpm8.3 -t`, `systemctl daemon-reload`.
8. **First start**: `sudo -u wms php /opt/wms/backend/tools/init.php` creates `backend/data` (R36 first start) and prints the admin password once. It runs **before** the services start, so no stray internet request can seed the data first. On a later run it finds existing data and prints nothing.
9. **Start**: `systemctl enable --now php8.3-fpm caddy wms-backup.timer`, then a restart of both so new config is live.
10. **Firewall**: reads the SSH port from `sshd -T` and allows it (`ufw allow <port>/tcp`, so a custom SSH port does not lock the operator out), then `ufw allow 80/tcp`, `ufw allow 443` (TCP and UDP for HTTP/3), `ufw --force enable`.
11. **Check**: `curl -fsS https://$WMS_DOMAIN/api/health` (retried for about 60 s while the certificate is issued). It prints the URLs for the office and drivers, and prints `backend/data/initial-admin.txt` whenever that file exists, whoever created it.

Re-running install.sh rewrites the config files and restarts the services; it never changes `backend/data` beyond ownership.

**`deploy/update.sh`** (new version), in order:
1. `systemctl start wms-backup` (a backup before every update);
2. `git -C /opt/wms pull --ff-only`;
3. `npm ci && npm run build -- --outDir ../backend/public/app.new` in `frontend/`. The live `backend/public/app` stays untouched while the build runs, and a failed build leaves the site as it was;
4. copy the previous `app/assets/` files into `app.new/assets/` (without overwriting), so an office tab still open on the old version can still lazy-load its old chunks;
5. swap the folders with `mv` (`app` → `app.old`, `app.new` → `app`), then delete `app.old`;
6. `systemctl reload php8.3-fpm` (clears OPcache).

Data and config are untouched.

**Nightly backup** (`wms-backup.service` + `wms-backup.timer`):
```ini
# wms-backup.service
[Service]
Type=oneshot
User=wms
Group=wms
ExecStart=/usr/bin/php /opt/wms/backend/tools/backup.php /var/backups/wms --keep 30

# wms-backup.timer
[Timer]
OnCalendar=*-*-* 04:30:00
Persistent=true
[Install]
WantedBy=timers.target
```
- 04:30 is just after the default 04:00 rollover, so a backup holds the finished night shift. Any time is safe, because `backup.php` takes the same flock as the server, so `plan.json`, `users.json`, `days/` and the other JSON come from one moment. The dated folder is named in `config.tz` (`bootstrap.php`), not UTC.
- A dated folder holds the **whole data dir** except `.lock` and temp files: `plan.json`, `users.json`, `days/`, `secret.key`, `audit/`, the `*.bak` files and `files/` (§11.2).
- **Photos are stored once.** Each photo in a new dated folder is a hard link to the same file in the previous folder, so every folder is complete but the disk holds each photo only once. A backup that finds under 15% free disk exits non-zero, so `systemctl status wms-backup` shows the failure.
- `Persistent=true` runs a missed backup after the server was off.
- 30 dated folders are kept. `/var/backups/wms` is on the same disk, so the README also asks for the provider's automatic weekly snapshots and, monthly, an off-server copy to the office PC: `sudo tar -C /var/backups/wms -czf ~/wms-<date>.tgz <folder>` on the VPS, then `scp` it down. (`/var/backups/wms` is 0750 `wms`, so the copy needs sudo; tar keeps the hard links.)
- **Restore** (always the whole folder, never single files over live data, because day files written after the backup would no longer match the restored plan):
  1. `systemctl stop wms-backup.timer php8.3-fpm`;
  2. `mv /opt/wms/backend/data /opt/wms/backend/data.before-restore-<timestamp>`;
  3. `cp -a /var/backups/wms/<folder> /opt/wms/backend/data`;
  4. `chown -R wms:wms /opt/wms/backend/data && chmod 0750 /opt/wms/backend/data`;
  5. `systemctl start php8.3-fpm wms-backup.timer`.

  A backup without `secret.key` still opens: FileStore makes a new key and users sign in again (§4.2).
- **Trying a backup elsewhere** (M9 drill): point a local or scratch backend at a copy of the folder with `WMS_DATA_DIR=<folder>` (or `data_dir` in `config.local.php`, §11.2); never edit the tracked `config.php`.

**Use.**
- Office PCs open `https://<domain>/`. Drivers open `https://<domain>/driver` and use "Add to Home screen".
- A reboot (for example after a kernel update) needs no login: systemd brings Caddy and PHP-FPM back, and the certificate is renewed by Caddy on its own.
- Logs: `journalctl -u caddy` (requests, and PHP errors through `capture_stderr`), `journalctl -u php8.3-fpm` (the FPM master only), `systemctl status wms-backup`, and the audit log in `backend/data/audit/`.

**Capacity.** Each request takes milliseconds under the flock. 25 phones polling every 30 s plus office PCs is under 2 requests per second, well within 1 vCPU. If load ever grows, the Store moves to SQLite or MySQL (§4.1) with no change to the deployment shape.

---

## 12 Security
- **Transport**: HTTPS only (Caddy with Let's Encrypt, automatic renewal, HTTP redirected to HTTPS, plus HSTS). PHP-FPM listens only on a Unix socket, never on a TCP port. Plain HTTP on 8080 and 5173 exists only on the Windows PC for local development (§11.3).
- **Server** (VPS, §11.4):
  - `ufw` allows only SSH, 80 and 443.
  - SSH: key login only. Once the user's key works, the README writes `/etc/ssh/sshd_config.d/00-wms.conf` with `PasswordAuthentication no` and `KbdInteractiveAuthentication no`, then runs `sshd -t && systemctl reload ssh`, and checks with `sshd -T | grep -i passwordauthentication`. A drop-in named `00-…` is needed because sshd keeps the first value it reads, and many cloud images ship `50-cloud-init.conf` with `PasswordAuthentication yes`, which would override a setting in `sshd_config` itself.
  - Ubuntu's unattended security upgrades stay on; services come back by themselves after a reboot.
  - PHP runs as the unprivileged `wms` user with no login shell. It can write only `backend/data` and `/var/backups/wms`; the code is root-owned and read-only for it. Caddy cannot read `backend/data`.
- **Passwords**:
  - stored with `password_hash` (bcrypt by default) and checked with `password_verify`;
  - at least 8 characters;
  - the seed admin gets a random password on first start (no fixed default) and must change it on first login (R33);
  - an admin reset forces a change at next login.
- **Brute force**: 5 failures per username and client IP lock that pair for 10 minutes (R34). There is no sleep. Unknown usernames run `password_verify` against a dummy hash, so neither the message nor the timing says whether the username exists.
- **Tokens**:
  - HMAC-SHA256 with a 32-byte `secret.key` that is never committed, compared with `hash_equals`;
  - 30-day expiry;
  - revoked by bumping `token_version` (password change, reset, deactivate, sign out everywhere);
  - stored in localStorage. XSS risk is limited by React escaping and the CSP below.
- **Authorization**:
  - The role check is server-side on every endpoint (R33).
  - Driver GET endpoints return only today's (op_date) jobs. Driver result writes for an earlier run date are accepted only per R28 (first results from a driver in `holds`; corrections until the edit deadline, rollover + 8 h).
  - The rollover setting is admin-only (R33).
  - Drivers can never reach plan writes.
- **Validation**:
  - Every write is validated server-side against R3–R30, using whitelisted fields (unknown fields are rejected with `VALIDATION`).
  - JSON bodies are at most 1 MB. Caddy refuses any body over 3 MB before it reaches PHP (§11.4).
  - IDs are integers, and dates must match the `YYYY-MM-DD` regex and be real calendar dates.
- **Files**:
  - The name must match `^[0-9a-f-]{36}\.(jpg|png)$`, which rules out path traversal.
  - The magic bytes and size are checked.
  - Files are stored under `backend/data`, outside both Caddy roots, and served only through the API with auth and `Content-Type` set from the extension plus `X-Content-Type-Options: nosniff`.
- **Headers**, set in the Caddyfile `header` block (§11.4) so that every production response carries them, static files included:
  - `X-Content-Type-Options: nosniff`;
  - `X-Frame-Options: DENY`;
  - `Referrer-Policy: same-origin`;
  - `Content-Security-Policy: default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; connect-src 'self'`.
  - PHP also sets them on API responses, so local development on port 8080 behaves the same.
- **CORS**: none. The app is same-origin, through the Vite proxy in dev and one Caddy site in production.
- **Data safety**:
  - atomic writes with `fsync`, `.bak` copies, `DATA_CORRUPT` instead of overwriting an unreadable file (R36), and a nightly backup (`wms-backup.timer`, 04:30, 30 days kept) that takes the lock, plus provider snapshots and an off-server copy (§11.4);
  - the audit log of every write request (R36);
  - the visit history for every result change.
- **Secrets**: none in the repo. `backend/data` is git-ignored. `deploy/install.sh` takes only the domain (`WMS_DOMAIN`) and contains no passwords; the admin password is generated on the server (R33).

---

## 13 Testing approach
- **Backend rules**: `php backend/tests/run.php`.
  - A plain-PHP, table-driven runner (no PHPUnit). Each case in `tests/cases/*.json` is `{name, now, given:{plan, users, days}, call, expect:{status, code, data_subset, docs_subset}}`, and `now` is injected.
  - Groups:
    - Schedule:
      - type legality;
      - PH auto-pause;
      - Sunday + PH generated once;
      - overrides and their cleanup;
      - archived and non-routable customers dropped;
      - tasks on Sunday and PH;
      - recurring tasks on PH;
      - task overrides.
    - Plan, with every error code:
      - `CODE_IN_USE`, including overlap vs. schedule split and adhoc code reuse on another date;
      - `CUSTOMER_NOT_ROUTABLE`;
      - `CUSTOMER_IN_USE`, detach and archive;
      - `TYPE_ROUTABLE`, `CUSTOMER_LACKS_TYPE` and `RECURRING_NOT_ALLOWED`;
      - R12 scope cases (template replace when D is the next run date, R14 split otherwise, note to override(D));
      - R14 (re-pointing `copied_from`) and R15 (code suggestion, regular vs adhoc vs special result type, the `copied_from` link, skip_source with `release_run`);
      - holiday seed import per `seeded_years` (a new seed year is added once; a deleted holiday is not re-added; a seed year added late imports only dates > today and changes neither today's runs nor past days);
      - R11 on unchanged fields: `PATCH /api/routes/5 {rev, name, start: "2026-11-02"}` (start unchanged and in the past) returns 200; changing start to a past date returns `PAST_DATE_LOCKED`.
    - Freeze: a template, task or holiday edit today leaves yesterday unchanged; a deleted route still renders from its snapshot.
    - **Operational day and rollover** (R1; rollover 04:00 unless stated; jobs dated Wed 2026-11-11 and Thu 2026-11-12):
      - `Clock::opDate`: 2026-11-12T03:59:59 → 2026-11-11; 2026-11-12T04:00:00 → 2026-11-12; 2026-11-12T00:00:00 → 2026-11-11; with rollover 0, 2026-11-12T00:00:00 → 2026-11-12. `/api/meta` returns `today` and `day_ends_at` accordingly.
      - At 03:59: a claim on Wed's job succeeds and Thu's job returns `NOT_TODAY`; `/api/driver/today` lists Wed; a Wed plan write is accepted; Wed is not frozen; a held Wed run is `active`; a Wed result write by the holder has no `LATE` flag and counts in Wed's totals.
      - At 04:00: the first request freezes Wed (`frozen_through` = 2026-11-11); a claim on Wed's job returns `NOT_TODAY` and Thu's job is claimable; a Wed plan write returns `PAST_DATE_LOCKED`; the Wed run shows `incomplete` and an unclaimed Wed job `no_record`; a first result on Wed is accepted with `LATE`; the Wed holder's leave or finish returns `NOT_TODAY`.
      - `LATE` effective time (R28): a holder's stop captured at 03:50 and received at 04:05 has no `LATE`; one captured at 04:01 has `LATE`; a `captured_at` before the hold started, or after `received_at`, falls back to `received_at`.
      - Edit deadline: a Wed correction at 2026-11-12T11:59:59 is accepted; at 12:00:00 it returns `EDIT_WINDOW_CLOSED`; with rollover 2 the deadline moves to 10:00.
      - Settings: `PATCH /api/settings` by office returns `FORBIDDEN`; rollover 7 returns `VALIDATION`; at 2026-11-12T03:00 changing 4 → 2 (today would jump to Thu) and at 2026-11-12T03:00 with rollover 2 changing 2 → 4 (today would go back to Wed) both return `ROLLOVER_SHIFTS_TODAY` with `retry_after` = 2026-11-12T04:00; at 10:00 any value 0–6 is accepted.
      - Clock behind the freeze: with `frozen_through` = 2026-11-11 and now = 2026-11-12T03:00 (today = Wed), every request returns 503 `CLOCK_BEHIND_FREEZE` and writes nothing.
      - `fake_now` is ignored when the data dir has no `.demo` marker.
      - The clock is read once, after the lock (R1): a test clock records that `Clock::now()` is first called while the lock is held.
    - Storage: an undecodable `plan.json` or day file returns `DATA_CORRUPT` and writes nothing; a missing plan with a `.bak` present is not a first start; a missing `secret.key` on a later start is recreated and old tokens return 401.
    - Runs:
      - the R22 status table;
      - claim order;
      - route-vs-task holding (one route plus N tasks);
      - switch atomicity;
      - assign and reassign;
      - R24 outcomes (the run is never deleted; resolved = 0 shows as not_started; a late write after release is accepted with `LATE`);
      - claim and assign both run `finishIdleRouteHold`;
      - close-out on a job with no run;
      - R26 with `release_run` (runs moved to `dropped_runs`) and `run.removed`.
    - Visits:
      - weighable-type matrix (REL refused on a task, OTC refused on a route);
      - `TICKET_REQUIRED` only for weighbridge types;
      - `FILE_MISSING`;
      - the R30 matrix (replay by op_id, base_rev match, same principal, conflict kept in history);
      - edit window (a late first result is accepted; a correction after the edit deadline, rollover + 8 h, is refused);
      - `NOT_ON_JOB` (another customer on a task job; a customer never on the route; a customer in `run.removed` is accepted as `OFF_PLAN`);
      - `OFF_PLAN`, `LATE`, `WHY_REQUIRED`.
    - Auth: lockout per username + IP (and cleared by reset), token expiry, `token_version` bump, role matrix, `PASSWORD_CHANGE_REQUIRED`, `LAST_ADMIN`, random seed admin password, audit redaction of `password`/`old`/`new`.
- **Concurrency**: `php backend/tests/race.php` starts 10 CLI processes that claim the same job through `FileStore` on one temp data directory. Exactly one may win, and the files must stay valid JSON.
- **Backup**: `php backend/tests/backup_test.php` runs `tools/backup.php` twice on a temp data dir with photos. The second dated folder holds every data file, including `secret.key` and `audit/`; its photos are hard links to the first folder's (same inode), and only a new photo is a fresh copy. `--keep` deletes only folders older than the limit.
- **API smoke**: `php backend/tests/api_smoke.php` drives the router in-process over a temp data dir (with a `.demo` marker) through one scripted day:
  1. seed;
  2. create routes and tasks;
  3. two drivers race to claim;
  4. submit stops with a photo upload;
  5. switch route;
  6. office adds a stop and removes another;
  7. a driver takes an OTC task while holding a route;
  8. office corrects a weight;
  9. `fake_now` moves to 02:30 the next calendar day (a night-shift stop on the same day's route is accepted without `LATE`), then to 03:59 (still the same day), then to 04:00 (the rollover), showing no_record and incomplete;
  10. close out.
- **Frontend**:
  - `tsc --noEmit`;
  - `vitest` for:
    - `outbox.ts` (coalescing, order, files before visit, and the 200/409/422/401/network handling);
    - `api.ts` mappers;
    - the search and highlight filter;
    - `StopList` reordering: a drag end, ↑ ↓ and "move to #" produce the same draft order (`arrayMove`);
    - the rollover refetch: a poll response (or the `day_ends_at` timer) with a new `today` triggers a `/api/meta` refetch, a Today reload, and the invalidation of every query, including a calendar range that does not contain today;
    - i18n key parity.
- **Drag and drop, manual**: reorder a 30-stop route in the drawer with a mouse (Chrome, Edge), with touch on a tablet (press and hold the handle; a swipe still scrolls), and with the keyboard.
- **Deployment**: `shellcheck deploy/*.sh`; `deploy/install.sh` is run on a fresh Ubuntu 24.04 VPS (M1b), then run a second time to prove it is idempotent; a reboot brings the site back with no login; `systemctl list-timers` shows `wms-backup.timer`; `deploy/update.sh` runs while an office tab is open, and the tab keeps working (no blank page, old chunks still load).
- **Manual demo** at each milestone: a desktop, plus at least two real phones on 4G over HTTPS (the VPS, available from M1b) from M6 onward. Airplane-mode test in M8.
- **Edge cases**: every case D01–D36 is a named test, or is marked deferred in §16.

---

## 14 Milestones (each ends with a demo)
**M1 Skeleton, time, login.**
- Contents:
  - the repo layout and the Windows .bat scripts for local development (`start-backend.bat`, `start-frontend.bat`, `start.bat`, `build.bat`) and the `index.php` static/SPA fallback for `php -S`;
  - the front controller with the envelope and ApiError;
  - `Clock` (fake_now, op_date with the rollover hour, R1) and `settings.rollover_hour = 4` in the seed;
  - FileStore (lock released in `finally`, atomic write with fsync, .bak, `DATA_CORRUPT`, first-start detection, seed with a random admin password, `umask(0027)`) and `tools/init.php`;
  - `GET /api/meta` (`today` = op_date, `rollover_hour`, `day_ends_at`);
  - users with login, token, lockout, forced password change and `/api/me` (language).
  - Vite app shell with zh/en switching. `tests/run.php` with the first dayClass, op_date (03:59 vs 04:00) and auth cases.
- **Demo (local, Windows):** run `start.bat`. On the PC, open `http://localhost:5173/`, log in as admin with the password printed in the backend console, change it and switch zh ↔ en. Then `build.bat` and the same at `http://<pc-ip>:8080/` from another PC on the office network. Optional: if the VPS of M1b is already up, repeat the login at `https://<domain>/` from a phone on 4G.

**M1b VPS deployment and HTTPS** (can run in parallel with M2–M5; must be done before M6).
- Contents:
  - `deploy/install.sh`, `deploy/update.sh`, the `deploy/Caddyfile` template, the PHP-FPM pool, the systemd restart drop-ins and `wms-backup.service`/`.timer` (§11.4);
  - `tools/backup.php` with `--keep`;
  - README: DNS A record, install, update, restore.
- Needs from the user: a VPS (Ubuntu 24.04 LTS) with SSH access; a domain name with a DNS-only A record (not proxied) pointing at it (§15 Q2, Q3); 80/tcp, 443/tcp and 443/udp open in the provider's firewall; and, for a private repo, a read-only deploy key (§11.4).
- **Demo:** on a fresh VPS, run `sudo WMS_DOMAIN=<domain> bash deploy/install.sh`; it prints the admin password. A phone on 4G opens `https://<domain>/` with a valid certificate and logs in. `sudo reboot`: the site comes back with nobody logged in. `systemctl list-timers` shows the 04:30 backup; `sudo systemctl start wms-backup` writes a dated folder. Re-running install.sh changes nothing in the data.

**M2 Master data.**
- Contents:
  - waste types (with routable, weigh method, abbr, unit, recurring_tasks and confirm_over; the deactivation guard);
  - customers (CRUD, waste-type chips, archive and restore, search);
  - holidays page (2026 seed; **2027 entered from the MOM list and confirmed by the user**, reaching existing data through `seeded_years`, R16);
  - trucks (the vehicle list drivers pick from, R23);
  - Settings: the day rollover hour (admin only, `ROLLOVER_SHIFTS_TODAY`, R1);
  - the Users page.
- **Demo:** create customer A (REL), customer B (REL + OTC) and customer C (COMPACTOR); create driver accounts; add two truck plates; add a test holiday; past holidays are shown locked. An office user sees the rollover hour read-only; the admin changes it to 05:00 and back.

**M3 Routes and calendar (read).**
- Contents:
  - route create for all three types (code, colour, legality, `CODE_IN_USE`);
  - Schedule;
  - freeze;
  - `GET /api/calendar`;
  - week view with one-line rows and month view with code chips;
  - legend, highlight, search and type filters;
  - the paused (PH) line;
  - the missing-holiday banner;
  - read-only past days;
  - the Today marker on the op_date ("Today · until {time}" after midnight).
- **Demo:** 12+ routes fill the week. Clicking `E2` highlights it everywhere. Searching for a customer finds its routes. Fri 25 Dec (Christmas) shows the regular routes paused. Sunday offers only Special. The `fake_now` steps run locally on a copy of the data folder with a `.demo` marker (R1), never on live data, and each starts from a fresh copy: with `fake_now` set two days ahead, the frozen past days do not change after a template edit; with `fake_now` at 03:59 the next calendar day, the previous date is still Today and editable; at 04:00 it shows the lock.

**M4 Container editing.**
- Contents:
  - the route drawer with drafts (add routable customers only, remove, reorder, notes);
  - `StopList` reordering: drag and drop with `@dnd-kit/core` + `@dnd-kit/sortable` (mouse, touch, keyboard, auto-scroll), plus ↑ ↓ and "move to #"; reused in the Routes page template editor;
  - the scope dialog;
  - skip, restore and reset;
  - Copy to date (Run on PH / Move to work day, the `covered by` label);
  - edit schedule (from today, from D);
  - end and delete;
  - Urgent pickup;
  - `STALE_REVISION` and `HOLIDAY_CONFLICT`.
- **Demo:** the user's case "phone call today, tomorrow go to A and B" takes about 4 clicks. A customer removed "1 Dec and following" disappears only from 1 Dec (R12; the route is split, same code). The PH-paused N1 is run on 25 Dec as `N1-25`, and a paused route moved to a work day shows the R tag, not ⚡A. A 30-stop route is reordered by dragging with a mouse and on a tablet by touch; stop 28 is moved to #2 by typing; the draft saves through the scope dialog.

**M5 Tasks (office).**
- Contents:
  - "+ Task" (OTC one-off, COMPACTOR one-off and recurring, with "add type to customer");
  - task rows and the collapsed Tasks group in the week view, and the task chip in the month view;
  - the task drawer (skip, move, edit series, end, delete);
  - the Tasks page;
  - search over tasks.
- **Demo:** a COMPACTOR task every Tue and Fri appears on 25 Dec (a PH) and on Sundays when chosen. An OTC task on Sunday works. The day with 12 routes and 5 tasks stays readable.

**M6 Driver claim and live status.**
- Contents:
  - the driver app: S0 login, S1 Today (routes and tasks), S2 and S2T previews with the plate;
  - claim, switch and give back;
  - office release and assign;
  - status glyphs, ops line and day drawer in the calendar;
  - the R26 dialog;
  - 30 s polling, and the rollover refetch when `today` changes (R36).
- **Demo** (on the VPS, phones on 4G): two phones confirm the same route and one sees "Taken by Ali". Ali holds N1 and also takes two OTC tasks. Ali switches to A2 and N1 shows "Needs driver" in the office within 30 s. The office assigns N1 to Bala.

**M7 Results and corrections.**
- Contents:
  - S4 (weights per weighable type, [0] chip, confirm_over, ticket when weighbridge, photos with resize and upload, signature pad, note, not-collected reasons);
  - task completion;
  - S3, S5 and S6;
  - driver correction and undo on today's jobs;
  - the office Result dialog (why, history, photos);
  - Close out and back-fill;
  - day totals.
- **Demo:** a full route from Confirm to Done, with photos and a signature. A COMPACTOR task is completed. In Settings, OTC is switched to Weighbridge, and the ticket becomes required on the next OTC task. The office corrects a weight with a reason, and the phone shows it.

**M8 Field robustness.**
- Contents:
  - the IndexedDB outbox (files first, op_id replay, coalescing, backoff);
  - the S7 Not sent screen;
  - cached Today and job views;
  - the service-worker app shell;
  - the LATE and CONFLICT paths;
  - `EDIT_WINDOW_CLOSED` (deadline = rollover + 8 h);
  - the rollover transitions (03:59 → 04:00, R1), including the driver app's "Day closed at {time}" reload;
  - driver deactivation releasing jobs;
  - `race.php`, run on the Windows PC and on the VPS (flock on both).
- **Demo** (on the VPS): airplane mode for 3 stops with photos, then reconnect and everything syncs exactly once. The app is reopened with zero signal. Night shift (locally, on a `.demo` copy of the data folder, never on the VPS's live data, R1): with `fake_now` at 02:30 the next calendar day, the driver still sees the previous date's route, finishes a stop without `LATE`, and the day totals include it; at 04:00 the driver's list shows the new day and the calendar shows a "No record" route and an incomplete run with [Close out].

**M9 Operations and hardening.**
- Contents:
  - backups checked: a week of nightly folders from `wms-backup.timer` (photos hard-linked, not copied: `du -sh /var/backups/wms` grows by about one day of photos per night), pruning after 30 days, and a restore drill (a dated folder restored on the VPS by the §11.4 steps, and a copy of the same folder opened locally with `start-backend.bat` and `WMS_DATA_DIR`);
  - provider snapshots switched on; SSH password login switched off;
  - `deploy/update.sh` used to ship a new version with no data change;
  - README complete: local development (.bat), VPS install, update, backup, restore, logs;
  - the full D01–D36 test table passing;
  - `api_smoke.php`.
- **Demo:** the VPS is rebooted and comes back with nobody logged in. The office works at `https://<domain>/` and drivers on 4G at `https://<domain>/driver`. Last night's backup is restored into a scratch data folder and opens correctly.

---

## 15 Open questions (still undecided by the user; v1 is built with the default)
| # | Question | Default used in v1 |
|---|---|---|
| Q1 | Which waste types are weighed at a weighbridge, and for a route load is there one ticket per customer or one per truck load? (The user said "later".) | All types are `on_site`. `weigh_method` is a per-type setting the admin can change without code; when it is `weighbridge`, a ticket number is required per visit for that type. Per-load tickets ("trips") come later if needed. |
| Q2 | Which domain name does the server use? | A subdomain of the company's domain, such as `wms.<company>.com.sg`, with a DNS A record pointing at the VPS. It is needed before `deploy/install.sh` runs (M1b), because Let's Encrypt checks it. Changing it later means editing `/etc/caddy/Caddyfile` (or re-running install.sh with the new `WMS_DOMAIN`); drivers then re-add the home-screen icon. |
| Q3 | Which VPS provider and size? | Any provider with a **Singapore region** and Ubuntu 24.04 LTS images (for example DigitalOcean, Vultr, Linode/Akamai or AWS Lightsail). Suggested size: 1 vCPU, **2 GB RAM** (the frontend build is done on the server), **50 GB SSD**. Photos dominate the disk: about 400 stops a day with a photo on half of them at about 300 KB is about 60 MB a day, about 22 GB a year. Backups add little: the JSON is copied into each of the 30 dated folders (a few MB each), while each photo is stored once through hard links (§11.4), so live data plus backups stay about 22 GB a year plus well under 1 GB. Switch on the provider's automatic weekly snapshots. Resize the disk, or move `files/` to a mounted volume, when it passes 70% (cleanup of old photos is deferred, §16). |

**Decided since the previous version** (no longer open; the rules are in the sections named):
- Hosting: a Linux cloud VPS for production; local development and trials stay on the Windows PC with .bat files (§1, §11.3, §11.4).
- Recurring COMPACTOR tasks run on public holidays; the office skips single dates (R18).
- A PH-paused regular route copied or moved to another work day keeps type REGULAR (R tag, solid border, that date only); adhoc stays for emergencies (R6, R15).
- Reports in v1: daily totals per waste type in the calendar only; CSV/Excel export is the first v2 item (R32, §16).
- Two trucks never share one route on the same day: one route, one driver at a time (R23, R25).
- Truck plates: the office maintains the vehicle list in Settings and drivers pick from it (R23, §9.2).
- Overnight work: night shifts exist; the day rolls over at 04:00 by default, configurable by an admin (R1).
- Reordering stops: drag and drop plus ↑ ↓ and "move to #" (§6.1, §11.1).

---

## 16 Deferred to later
1. **Reports**: CSV/Excel export and weight reports per customer, waste type, period and driver. This is the **first v2 item** (user decision): one endpoint over the day files. A "period closed" lock for invoiced months.
2. **Weighing detail**: per-load weighbridge "trips", several readings per stop, and bin counts.
3. **Required evidence**: per-customer "photo required" and "signature required" flags (the user said "later").
4. **Assignment**: office pre-assignment of drivers or trucks for future dates. (Assignment for today is in v1.)
5. **Shared routes**: two trucks on one route at the same time. (Not planned: the user decided one route = one driver.)
6. **Switching**: "Pause and keep my claim" when switching route. (v1 gives the remaining stops back.)
7. **Weight checks**: checks against a customer's history (for example the median).
8. **Route history**: route versions and template history; per-stop start/end dates inside one template (v1 splits the route from D instead, R12); carrying "following" edits into dates that already have their own list.
9. **Moving occurrences**: dragging a route or task occurrence from one date to another, or "move" with ghosts. (Copy plus skip covers this. Drag-and-drop reordering of stops inside a route is in v1, §6.1.)
10. **Dry runs**: dry-run previews and a conflict status with a Fix menu. (v1 refuses the write and explains why.)
11. **Coverage warning**: a `DUPLICATE_COVERAGE` warning.
12. **Holidays**: holiday import (CSV or online) and per-state calendars.
13. **Deletion**: hard delete of customers and waste types.
14. **Audit and customer pages**: an audit-log viewer UI (v1 writes the JSONL file) and a customer visit-history page.
15. **Layouts and schedules**: a mobile layout for the office calendar; separate stop lists per weekday; fortnightly or monthly patterns; task time windows.
16. **Storage**: a SQLite or MySQL Store (the interface is ready); cleanup of orphan and old photo files; moving photos to object storage.
17. **Push**: websockets and push notifications. (v1 polls every 30 s.)
18. **Languages**: Malay or other languages.
19. **Operations**: off-site backup automation (v1 relies on provider snapshots plus a manual monthly download), uptime monitoring and alerting.
