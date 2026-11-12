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
- Deployment with GitHub Actions. Every push runs the tests on GitHub.
- Then the user narrowed it: "deploy only the frontend, the calendar part" and "no login, but give me a demo of the calendar's routes".
  - Offered read-only / editable / connected to a server, the user chose an EDITABLE demo. It is the office calendar on GitHub Pages, with no login and sample routes. The real backend runs in the visitor's browser (php-wasm), so editing works exactly as in the real system. Changes stay only in that browser, and the visitor can reset them.
  - Offered a private link or GitHub Pages for a private repo (which needs a paid plan), the user chose to make the repository PUBLIC, so GitHub Pages works on the free plan.
  - No automatic deploy to a server for now (the user's choice). The production design of section 11.4 stays for later.
## Round 7 (waste types and routes, replaces the task rules of rounds 2-4)
- "这三个不tag to route erose,otc,compactor, rel/recycling 要tag to route." (EROSE, OTC and COMPACTOR are not on routes; REL and Recycling are.)
- New waste types: EROSE (not on routes) and RECYCLING (on routes). "REL是general waste, Recycling 是另一种方式" (REL is general waste; Recycling is a separate type). REL keeps its name "REL".
- "otc,compactor, erose 不要放入calender的计划." Asked what that means, the user chose: the system does not plan these three at all. No tasks, no task group on the calendar, no Tasks page, no task claims in the driver app.
- "OCT,Compactor, erose 不用设置任务,可以随意提交.." (no tasks to set up; they can be submitted freely). The user chose:
  - The DRIVER submits them on the phone at any time: pick the waste type, pick the customer, enter the weight (photo, signature, weighbridge ticket and truck plate as for route stops). No office set-up and no claiming.
  - The customer is picked from the customer list; only customers registered with that waste type are listed.
  - The office sees them on a records page (by date) and they COUNT in the calendar's daily totals per waste type. They are not shown one by one on the calendar.
- One route collects ONE waste type (the user chose this over "both on one route"): REL or RECYCLING is picked when the route is made; only customers registered with that type can be added; on that route the driver enters only that type's weight.
- The old task feature's CODE is removed (the user chose this). Stored task data in existing data files is left as it is, only no longer shown.
- Decisions taken while building (2026-11-12; the user set these defaults and confirmed the design):
  - The waste type of a route cannot change after the route is made; to change it, make a new route. A split ("this date and following"), a schedule change, a copy, a PH move and an urgent route keep or ask for the type.
  - A route in old data that has no waste type counts as REL. It is read that way; the data files are not rewritten.
  - An existing data folder does not get RECYCLING and EROSE by itself; the admin adds them in Settings. New installs and the demo have them. Seed order: REL, RECYCLING (name Recycling, abbreviation RCY), OTC, COMPACTOR, EROSE.
  - Submissions are stored by operational date (before the rollover hour it is still the previous day). A driver may change or delete their own submission inside the same edit window as a route stop result. The office can only read them in this round: no create, change or delete.
  - The waste-type setting `recurring_tasks` is removed (a stored value is ignored).
  - Deactivating a type that is not on routes is always allowed (it leaves the driver's pick list). Deactivating a type that is on routes is refused while routes still use it (409 WASTE_TYPE_IN_USE).
  - A waste type cannot be removed from a customer while that customer is on a route of that type.
  - A submission keeps a snapshot of the customer's code and name.
  - Weights of old tasks no longer count in the calendar's daily totals: the user's wording "不再显示、不再计算" (no longer shown, no longer counted) was followed literally. The old task data stays on disk untouched.
  - The waste type and the customer of a submission cannot change; a wrong one is deleted and submitted again.
  - A submission has no "not collected": nothing was planned for it.
  - A submission made offline that is more than 7 days old when it reaches the server is refused (the limit is a config value).
  - Every submission needs a truck plate (no claim picks one); the form pre-fills the last plate used.
  - "就用26.5.0" (use Node 26.5.0): the local run on the user's Mac used Node 26 by the user's choice; the project and GitHub Actions stay on Node 22.
- Route colour (2026-11-12, user chose "option A"): the route code is shown on the route's colour instead of next to a thin colour bar; a new route takes the colour of a live route whose code starts with the same letter (colour = area), else the least-used colour; the colour stays editable and existing routes are not recoloured. Calendar route lines no longer show the `R` tag (regular) or the `REL` tag; `S`, `⚡A` and `RCY` stay.
- Colour = progress (2026-11-12, user: "颜色不用使用不同颜色来代表不同路线,但是可以通过颜色来查看路线的现状"; scheme agreed in chat): on the calendar a route code is grey (not started, also future days), ochre (under way, under half), blue (under way, half or more), green (all stops collected) or red (problem: a past day not finished or without a record, a route that needs a driver, or a stop not collected). This replaces colour-per-area on the office pages; the colour field left the route form, stored colours are kept. In the route drawer a collected stop is green, a not-collected stop red, a pending stop has no colour.
- Looks (2026-11-12, user: "参考北宋千里江山图的配色来做整体美术风格和saas风格,风格可以切换"): two looks for the office pages, "Jiangshan" (default) and "Plain", switched in the header and remembered per browser. The driver app is unchanged (high contrast for sunlight).
