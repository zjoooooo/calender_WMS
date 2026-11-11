<?php
// The ONLY place that reads the system clock (R1). One instance per request: now() is read once
// (memoised), after the lock is taken (R36). Static helpers compute op_date, day_start/day_end and
// the edit deadline. All times are in the configured time zone (Asia/Singapore, set by bootstrap).
final class Clock
{
    private ?DateTimeImmutable $now = null;

    /** Tests: called once, right before the clock is first read. */
    public ?Closure $onFirstRead = null;

    /**
     * @param array $config needs tz, data_dir, fake_now
     * @param DateTimeImmutable|null $fixed injected "now" (in-process tests); bypasses fake_now
     */
    public function __construct(private array $config, private ?DateTimeImmutable $fixed = null)
    {
    }

    public function now(): DateTimeImmutable
    {
        if ($this->now === null) {
            if ($this->onFirstRead !== null) {
                ($this->onFirstRead)();
            }
            $tz = new DateTimeZone($this->config['tz'] ?? date_default_timezone_get());
            $this->now = ($this->fixed ?? $this->read())->setTimezone($tz);
        }
        return $this->now;
    }

    public function nowIso(): string
    {
        return self::iso($this->now());
    }

    private function read(): DateTimeImmutable
    {
        $fake = $this->config['fake_now'] ?? null;
        if (is_string($fake) && $fake !== '') {
            if (is_file(rtrim((string) $this->config['data_dir'], '/') . '/.demo')) {
                return new DateTimeImmutable($fake);
            }
            error_log('WMS warning: fake_now is set but the data dir has no .demo marker; using the real clock');
        }
        return new DateTimeImmutable('now');
    }

    /** True when fake_now is configured AND honoured (the data dir has a .demo marker). */
    public function isFake(): bool
    {
        $fake = $this->config['fake_now'] ?? null;
        return is_string($fake) && $fake !== '' && is_file(rtrim((string) $this->config['data_dir'], '/') . '/.demo');
    }

    // ---- pure helpers -------------------------------------------------------------------

    /** op_date(now) = calendar date of (now - H hours) in the configured time zone (R1). */
    public static function opDate(DateTimeImmutable $now, int $rolloverHour): string
    {
        $local = $now->setTimezone(new DateTimeZone(date_default_timezone_get()));
        return $local->modify('-' . $rolloverHour . ' hours')->format('Y-m-d');
    }

    /** day_start(D) = D at H:00. */
    public static function dayStart(string $date, int $rolloverHour): DateTimeImmutable
    {
        return new DateTimeImmutable(sprintf('%s %02d:00:00', $date, $rolloverHour), new DateTimeZone(date_default_timezone_get()));
    }

    /** day_end(D) = (D + 1) at H:00. */
    public static function dayEnd(string $date, int $rolloverHour): DateTimeImmutable
    {
        return self::dayStart(Dates::addDays($date, 1), $rolloverHour);
    }

    /** Edit deadline of a run (R28) = day_end(date) + grace hours. */
    public static function editDeadline(string $date, int $rolloverHour, int $graceHours): DateTimeImmutable
    {
        return self::dayEnd($date, $rolloverHour)->modify('+' . $graceHours . ' hours');
    }

    /** ISO 8601 with offset, e.g. 2026-11-11T07:40:02+08:00. */
    public static function iso(DateTimeImmutable $t): string
    {
        return $t->setTimezone(new DateTimeZone(date_default_timezone_get()))->format('Y-m-d\TH:i:sP');
    }

    /** Parses an ISO 8601 timestamp; null when invalid. A missing offset means the configured zone. */
    public static function parse(mixed $s): ?DateTimeImmutable
    {
        if (!is_string($s) || !preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/', $s)) {
            return null;
        }
        try {
            return new DateTimeImmutable($s, new DateTimeZone(date_default_timezone_get()));
        } catch (Exception) {
            return null;
        }
    }
}
