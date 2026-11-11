// Run status as glyph + short word + count (§8.3): never colour alone.
//   planned      "8"                 (stop count, muted; tasks show "–")
//   not_started  "○ Unclaimed 0/8"
//   active       "◑ Ali 3/8"
//   open         "⇄ Needs driver 3/8" (amber)
//   done         "✓ Ali 8/8" (green); task: "✓ Ali" or "✗ Not collected"
//   incomplete   "! Incomplete 6/8"  (red)
//   no_record    "– No record"       (grey)
//   cancelled    struck-through "skipped"; holiday_skipped "⏸ Paused (PH)"
import type { OccurrenceStatus, RunStatus } from '../api';
import { useI18n } from '../i18n';

export type GlyphStatus = RunStatus | Exclude<OccurrenceStatus, 'scheduled'> | null;

export const GLYPHS: Record<string, string> = {
  planned: '',
  not_started: '○',
  active: '◑',
  open: '⇄',
  done: '✓',
  incomplete: '!',
  no_record: '–',
  cancelled: '',
  holiday_skipped: '⏸',
};

export interface StatusGlyphProps {
  status: GlyphStatus;
  kind?: 'route' | 'task';
  /** Holder (active) or last driver (done). */
  driver?: string | null;
  /** Resolved stops (collected + missed) and total, for the "3/8" count of a route. */
  resolved?: number;
  total?: number;
  /** Task done but not collected (missed): "✗ Not collected". */
  notCollected?: boolean;
  /** Tooltip. */
  title?: string;
  /** Month-view line (§9.2): glyph + driver (active, done) + count only, no status word; done drops the count. */
  compact?: boolean;
}

export function StatusGlyph({ status, kind = 'route', driver, resolved = 0, total = 0, notCollected, title, compact }: StatusGlyphProps) {
  const { t } = useI18n();
  if (!status) return null;
  const count = kind === 'route' ? ` ${resolved}/${total}` : '';
  let glyph = GLYPHS[status] ?? '';
  let word: string;
  switch (status) {
    case 'planned':
      if (compact && kind === 'task') return null;
      return (
        <span className="sg planned num" title={title ?? t('status.planned')}>
          {kind === 'route' ? total : '–'}
        </span>
      );
    case 'active':
      word = driver || t('status.active');
      break;
    case 'done':
      if (kind === 'task' && notCollected) {
        glyph = '✗';
        word = t('status.notCollected');
      } else {
        word = driver || t('status.done');
      }
      break;
    default:
      word = t(`status.${status}`);
  }
  const showCount = kind === 'route' && status !== 'cancelled' && status !== 'holiday_skipped' && status !== 'no_record' && !(compact && status === 'done');
  // Compact keeps the driver's name (active, done); the status word moves to the tooltip.
  const isName = (status === 'active' || status === 'done') && !!driver && !notCollected;
  if (compact && glyph && !isName) word = '';
  const cls = `sg ${status}${notCollected ? ' missed' : ''}`;
  return (
    <span className={cls} title={title ?? t(`status.${status}`)} aria-label={compact && !word ? title ?? t(`status.${status}`) : undefined}>
      {glyph && <span className="g" aria-hidden="true">{glyph}</span>}
      {/* .w = a status word, which a narrow week column hides (CSS); a driver's name (.who) always stays */}
      {word && <span className={isName ? 'w who' : 'w'}>{word}</span>}
      {showCount && <span className="num">{word ? count : count.trim()}</span>}
    </span>
  );
}
