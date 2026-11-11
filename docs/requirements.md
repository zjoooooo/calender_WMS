# All user requirements (verbatim Chinese + English gloss), in order

1. "做一个前端,对接后端php jason的数据,前端要求以日历形式显示,日期框内可以增加,删除,修改路线容器,路线容器内可以自由 增加 修改 删除 客户,客户按照顺序放置在路线容器中,顺序可调整,路线有三种类型 regular,special,adhoc, regular 只能设置为星期1-星期6,可单选多选,sepcial 只能设置星期天和公共假日,adhoc只应对紧急情况,比如今天收到电话,明天去客户A,B收垃圾. Adhoc不应用在拜天和公假日…设计一个好的逻辑以日历形式直观呈现给我"
   (Frontend + PHP JSON backend; calendar; add/delete/edit route containers in a date cell; add/edit/delete ordered customers inside a container, reorderable; route types regular (Mon-Sat, multi-select weekdays), special (Sunday & public holidays only), adhoc (emergency one-off, never Sunday/PH).)
2. "现场司机每天需要选择路线,然后确认路线后 再去收垃圾 并提交重量数据等等,当然司机中途有需要可以更换路线." (Drivers select a route daily, confirm it, collect, submit weights etc.; can switch route midway.)
3. "垃圾的种类有otc,rel 暂时这2种" -> then "第1种，挂在客户上" (waste types attached to the customer).
4. "每一种不同的route容器使用不同颜色表示,你来建议是否使用颜色,因为一天可能有10+的route 路线 颜色主要是给客户用来简单区分路线,如果有更好的方式,不用颜色也可以." -> Agreed approach (mockup shown): route CODE primary + per-route fixed colour bar secondary (auto-assigned, editable, may repeat) + R/S/A type tag (adhoc: lightning + dashed border) + click-to-highlight a route across the calendar + search by route code or customer name + fixed ordering by code; driver status as icon+text; week view rows collapsed to one line; month view shows code chips.
5. "用户需要维护一个公共假日的内容,因为每年不一样" (users maintain the public holiday list themselves every year).
6. "类型增加compactor" (waste types: OTC, REL, COMPACTOR).
7. "otc 和 compactor 都不要tag to route" (OTC and COMPACTOR are never in route containers; standalone tasks).

# User decisions (2026-11-11)
- Waste types: OTC, REL (configurable list), attached to CUSTOMER; driver enters weight per type the customer has.
- PHP backend: build a NEW one (PHP 8, JSON file storage, swappable to MySQL later).
- Public holiday on Mon-Sat: regular routes AUTO-PAUSE (grey), office can move to another workday or run as special.
- Holiday country: SINGAPORE (prefill 2026-2027, office can add ad-hoc holidays).
- Regular route with several weekdays: SAME customer list & order every day (different list -> separate route; one-day exception allowed).
- Driver submission extras: photo, customer signature, weighbridge ticket no., truck plate (plus default: weight per type, note, no-garbage/closed flag).
- Driver login: username + password.
- Office login: yes, simple username + password.
- Route identification: route CODE (primary, always visible) + fixed per-route colour bar (secondary, auto-assigned, editable) + R/S/A type tag (adhoc gets lightning + dashed border) + click-to-highlight across calendar; driver status as icon+text.
- User wants a static mockup page first (week with ~12 routes/day) before the full plan.
## Round 2 (after mockup)
- Holidays: maintained by users every year; system PREFILLS Singapore 2026-2027, users add/edit/delete afterwards.
- Waste types: OTC / REL / COMPACTOR (abbreviations only), configurable list, attached to customer.
- OTC = One Time Collection: a STANDALONE one-off task on the calendar, NEVER inside a route container.
  - On routes, drivers only enter REL / COMPACTOR weights; OTC weight only inside OTC tasks.
  - OTC tasks can be scheduled on ANY day (incl. Sunday / PH).
  - Drivers CLAIM OTC tasks themselves (same as routes); a driver can hold a route + several OTC tasks.
- Weighing: differs by waste type (some at weighbridge with ticket, some on-site) -> per-type setting; details asked next.
- Weighbridge vs on-site per waste type: NOT decided yet ("later") -> make it a per-waste-type SETTING (on-site | weighbridge), default on-site; changeable without code.
- Route assignment: drivers choose themselves, first to confirm gets it (one driver per route at a time); office can revoke/reassign.
- Switch route midway: unfinished stops go back to "needs driver" (any driver incl. original can continue; office can assign); submitted records stay under original driver.
- Network: server reachable from internet over HTTPS; phones queue submissions offline and resend.
- Driver cannot add off-route customers on site; must call office (office adds to today's route or creates OTC task).
- Only the driver is recorded (no helpers).
- UI language: Chinese/English switchable per user.
- Photo & signature: both OPTIONAL (per-customer "required" later).
## Round 3
- OTC AND COMPACTOR are NOT tagged to routes. Routes collect REL only. Implement as per-waste-type setting `routable` (REL=true, OTC=false, COMPACTOR=false).
- Only customers registered with REL can be added to a route (customers with only OTC/Compactor are not searchable in route picker).
- Compactor tasks: BOTH one-off and RECURRING (e.g. every Tue & Fri, auto-appears on calendar). Any day allowed incl. Sunday/PH (same as OTC). Drivers claim themselves (first to confirm).
- OTC tasks: one-off only, any day, drivers claim.
## Round 4 (after final design review)
- Hosting: CLOUD SERVER, LINUX (production). Local development/trial on the user's Windows PC still uses .bat scripts. Provide a one-shot install script + auto-start on boot + automatic HTTPS on Linux.
- Recurring COMPACTOR tasks DO run on public holidays (office can skip single dates).
- A PH-paused regular route copied/moved to another work day keeps type REGULAR (R tag, solid border, that date only). Adhoc stays for emergencies only.
- Reordering customers in a route: DRAG-AND-DROP + up/down buttons + "move to position N" (a small drag library is OK).
- Reports in v1: only daily totals per waste type in the calendar. CSV/Excel export is the first item of v2.
- One route = one driver at a time (no two trucks sharing a route on the same day).
- Truck plate: chosen from a vehicle list maintained by the office in Settings.
- NIGHT SHIFTS EXIST: day rollover time = 04:00 (configurable in Settings). Before 04:00, the operational "today" is still the previous calendar date (for drivers' Today list, claims, results, past lock, freeze).
## Round 5 (after first build, office calendar look)
- User sent a screenshot of the Apple Calendar month view as the reference: "make the calendar structure like this".
  - Month grid, Sunday..Saturday columns, big day number in each cell, one line per item (colour bar + title, short info right-aligned), holiday shown as a coloured bar in its cell.
- If a day has MORE THAN 4 routes, the cell collapses automatically; an "expand" control shows the rest in place (and collapses again).
- Clicking a single route in a cell opens it for editing.
- Today's date is shown in BLUE; public-holiday dates are shown in RED.
## Round 6 (after the split-route fixes)
- Split routes, later planned changes: the user chose option A. When an edit applies from today or from a date D, a later part of the route that already has its own planned change (e.g. "Tue/Thu from 21 Dec", or customers added or removed from a later date) KEEPS it; only what the clerk changed is carried into it. The screen must SAY SO before saving, and name what is kept.
- Deployment: run it with GitHub Actions. Every push runs the tests on GitHub; a push to main that passes the tests deploys to the Linux VPS (section 11.4 of Project.md) over SSH, using deploy/update.sh. The server, domain and SSH secrets are still to be provided by the user.
