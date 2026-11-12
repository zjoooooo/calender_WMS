// What the calendar views, drawers and dialogs share: the loaded range, the matcher and one `open()`
// that every row, chip, menu and button uses to open a drawer or dialog at page level.
import { createContext, useContext } from 'react';
import type { CalendarResponse, RouteOccurrence, TaskOccurrence } from '../api';
import type { Matcher } from './calendarModel';

export type CreateKind = 'regular' | 'special' | 'special_once' | 'adhoc';

export type Overlay =
  /** `since` (ms): opened before the occurrence exists (a new route); wait for the next refetch. */
  | { kind: 'route'; key: string; since?: number }
  | { kind: 'task'; key: string; since?: number }
  | { kind: 'day'; date: string }
  /** Copy to date (R15): mode 'ph' = Run on PH (same date), 'move' = Move to work day, 'copy' = free target. */
  | { kind: 'copy'; occ: RouteOccurrence | TaskOccurrence; mode: 'copy' | 'ph' | 'move' }
  | { kind: 'routeCreate'; date: string; type: CreateKind; dow: number }
  | { kind: 'urgent'; date?: string; customers?: number[] }
  | { kind: 'taskCreate'; date?: string };

export interface CalendarCtx {
  data: CalendarResponse;
  matcher: Matcher;
  hl: string | null;
  toggleHighlight: (code: string) => void;
  open: (o: Overlay) => void;
}

export const CalendarContext = createContext<CalendarCtx | null>(null);

export function useCalendar(): CalendarCtx {
  const c = useContext(CalendarContext);
  if (!c) throw new Error('useCalendar outside CalendarContext');
  return c;
}
