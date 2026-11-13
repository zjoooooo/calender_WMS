// Ordered stop list editor (§6.1), used by the route drawer and the Routes page template editor.
// Three equal ways to reorder, all the same arrayMove on the draft (stopDraft.ts):
// - drag and drop by the ⠿ handle (@dnd-kit; sensors exactly as §11.1: mouse after 5 px, touch after a
//   200 ms hold with 5 px tolerance, keyboard Space / ↑ ↓ / Space / Esc with screen-reader announcements);
//   the list auto-scrolls near the edges, the dragged row floats with a shadow and a placeholder marks the drop;
// - ↑ ↓ buttons;
// - "move to #": click the seq number and type a position.
import { useState, type CSSProperties, type ReactNode } from 'react';
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { Stop } from '../api';
import { useI18n, weekdayList, weekdayName } from '../i18n';
import { Chip } from '../ui/Chip';
import { dropMove, moveDown, moveToPosition, moveUp } from './stopDraft';

export interface StopRowView {
  name: string;
  /** Address and other muted detail. */
  detail?: ReactNode;
  /** Small tags on the name line (routable waste types). */
  tags?: ReactNode;
  /** A third line, only when there is something to show (result, "also on" …). */
  extra?: ReactNode;
  /** Visited rows keep their result: no ✕ (they can still be reordered). */
  locked?: boolean;
  /** Added in this draft. */
  isNew?: boolean;
  done?: boolean;
  /** The result of the stop: collected (green) or not collected (red). */
  tone?: 'ok' | 'miss';
  /** Clicking the name (e.g. opens the result dialog). */
  onOpen?: () => void;
}

export interface StopListProps {
  stops: Stop[];
  view: (s: Stop) => StopRowView;
  /** Add / remove / reorder / notes allowed. */
  editable: boolean;
  onChange: (stops: Stop[]) => void;
  onRemove: (index: number) => void;
  onNote?: (index: number, note: string) => void;
  /** With both, each stop gets the "Collection weekdays" control: the days the route runs, and the stop's new
   *  days (the standing list of a recurring regular route only). */
  routeDays?: number[];
  onDays?: (index: number, days: number[]) => void;
}

export function StopList({ stops, view, editable, onChange, onRemove, onNote, routeDays, onDays }: StopListProps) {
  const { t } = useI18n();
  const [dragId, setDragId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const ids = stops.map((s) => String(s.customer_id));
  const onDragStart = (e: DragStartEvent) => setDragId(String(e.active.id));
  const onDragEnd = (e: DragEndEvent) => {
    setDragId(null);
    const next = dropMove(stops, e.active.id, e.over?.id);
    if (next !== stops) onChange(next);
  };
  const dragged = dragId ? stops.find((s) => String(s.customer_id) === dragId) : undefined;
  const nameOf = (id: string | number) => view(stops.find((s) => String(s.customer_id) === String(id)) ?? { customer_id: 0, note: '' }).name;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragId(null)}
      accessibility={{
        announcements: {
          onDragStart: ({ active }) => t('stops.aPick', { name: nameOf(active.id) }),
          onDragOver: ({ active, over }) => (over ? t('stops.aOver', { name: nameOf(active.id), pos: ids.indexOf(String(over.id)) + 1 }) : ''),
          onDragEnd: ({ active, over }) => (over ? t('stops.aDrop', { name: nameOf(active.id), pos: ids.indexOf(String(over.id)) + 1 }) : ''),
          onDragCancel: ({ active }) => t('stops.aCancel', { name: nameOf(active.id) }),
        },
        screenReaderInstructions: { draggable: t('stops.aHelp') },
      }}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {stops.map((s, i) => (
          <SortableStop
            key={s.customer_id}
            s={s}
            index={i}
            count={stops.length}
            v={view(s)}
            editable={editable}
            onUp={() => onChange(moveUp(stops, i))}
            onDown={() => onChange(moveDown(stops, i))}
            onMoveTo={(pos) => onChange(moveToPosition(stops, i, pos))}
            onRemove={() => onRemove(i)}
            onNote={onNote ? (n) => onNote(i, n) : undefined}
            routeDays={routeDays}
            onDays={onDays ? (d) => onDays(i, d) : undefined}
          />
        ))}
      </SortableContext>
      <DragOverlay>
        {dragged ? <StopRowBody s={dragged} index={stops.indexOf(dragged)} count={stops.length} v={view(dragged)} editable={false} overlay /> : null}
      </DragOverlay>
    </DndContext>
  );
}

interface RowProps {
  s: Stop;
  index: number;
  count: number;
  v: StopRowView;
  editable: boolean;
  onUp?: () => void;
  onDown?: () => void;
  onMoveTo?: (pos: number) => void;
  onRemove?: () => void;
  onNote?: (note: string) => void;
  routeDays?: number[];
  onDays?: (days: number[]) => void;
}

function SortableStop(props: RowProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({
    id: String(props.s.customer_id),
    disabled: !props.editable,
  });
  return (
    <StopRowBody
      {...props}
      rowRef={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      placeholder={isDragging}
      handle={
        props.editable ? { ref: setActivatorNodeRef, props: { ...attributes, ...listeners } } : undefined
      }
    />
  );
}

function StopRowBody(
  props: RowProps & {
    rowRef?: (el: HTMLElement | null) => void;
    style?: CSSProperties;
    placeholder?: boolean;
    overlay?: boolean;
    handle?: { ref: (el: HTMLElement | null) => void; props: Record<string, unknown> };
  },
) {
  const { t, lang } = useI18n();
  const { s, index, count, v, editable, routeDays, onDays } = props;
  const [seqEdit, setSeqEdit] = useState<string | null>(null);
  const [noteEdit, setNoteEdit] = useState(false);
  const [daysEdit, setDaysEdit] = useState(false);
  const canDays = editable && !!routeDays && !!onDays;
  const own = s.days ?? routeDays ?? [];
  const cls = ['stop', v.done ? 'done' : '', v.tone ?? '', v.isNew ? 'new' : '', props.placeholder ? 'placeholder' : '', props.overlay ? 'overlay' : ''].filter(Boolean).join(' ');
  const commitSeq = () => {
    if (seqEdit !== null && seqEdit.trim() !== '') props.onMoveTo?.(Number(seqEdit));
    setSeqEdit(null);
  };
  return (
    <div ref={props.rowRef} style={props.style} className={cls} data-cid={s.customer_id}>
      {props.handle ? (
        <button type="button" className="handle" ref={props.handle.ref} {...props.handle.props} aria-label={`${t('common.dragHandle')} ${v.name}`}>
          ⠿
        </button>
      ) : (
        <span className="handle" aria-hidden="true" style={{ visibility: props.overlay ? 'visible' : 'hidden' }}>
          ⠿
        </span>
      )}
      {editable && seqEdit !== null ? (
        <input
          className="seqin"
          type="number"
          min={1}
          max={count}
          value={seqEdit}
          autoFocus
          aria-label={t('stops.moveTo', { name: v.name })}
          onChange={(e) => setSeqEdit(e.target.value)}
          onBlur={commitSeq}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitSeq();
            if (e.key === 'Escape') {
              e.stopPropagation();
              setSeqEdit(null);
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="seq"
          disabled={!editable}
          title={editable ? t('stops.moveToHint') : undefined}
          aria-label={editable ? t('stops.moveTo', { name: v.name }) : String(index + 1)}
          onClick={() => setSeqEdit(String(index + 1))}
        >
          {index + 1}
        </button>
      )}
      <div style={{ minWidth: 0 }}>
        <div className="sline">
          {v.onOpen ? (
            <button type="button" className="sn" onClick={v.onOpen}>
              {v.name}
            </button>
          ) : (
            <span className="sn">{v.name}</span>
          )}
          {v.tags}
          {s.days && (
            <span className="tag" data-testid="stop-days">
              {weekdayList(s.days, lang)}
            </span>
          )}
        </div>
        {v.detail && <div className="sa">{v.detail}</div>}
        {v.extra && <div className="wt">{v.extra}</div>}
        {editable && props.onNote && noteEdit ? (
          <div className="snote">
            <input
              value={s.note}
              autoFocus
              maxLength={200}
              placeholder={t('stops.notePlaceholder')}
              aria-label={t('stops.note')}
              onChange={(e) => props.onNote?.(e.target.value)}
              onBlur={() => setNoteEdit(false)}
              onKeyDown={(e) => e.key === 'Enter' && setNoteEdit(false)}
            />
          </div>
        ) : s.note ? (
          <div className="snote">📝 {s.note}</div>
        ) : null}
        {canDays && daysEdit && (
          <div className="chips" role="group" aria-label={`${t('stops.days')} ${v.name}`} style={{ marginTop: 4 }}>
            {routeDays.map((d) => {
              const pressed = own.includes(d);
              return (
                <Chip key={d} pressed={pressed} disabled={pressed && own.length === 1} onClick={() => onDays(pressed ? own.filter((x) => x !== d) : [...own, d])}>
                  {weekdayName(d, lang)}
                </Chip>
              );
            })}
          </div>
        )}
      </div>
      {editable ? (
        <div className="ops">
          {props.onNote && (
            <button type="button" className="icon-btn" onClick={() => setNoteEdit(true)} title={t('stops.note')} aria-label={`${t('stops.note')} ${v.name}`}>
              ✎
            </button>
          )}
          {canDays && (
            <button type="button" className="icon-btn" aria-pressed={daysEdit} onClick={() => setDaysEdit((x) => !x)} title={t('stops.days')} aria-label={`${t('stops.days')} ${v.name}`}>
              📅
            </button>
          )}
          <button type="button" className="icon-btn" disabled={index === 0} onClick={props.onUp} aria-label={`${t('common.moveUp')} ${v.name}`}>
            ↑
          </button>
          <button type="button" className="icon-btn" disabled={index === count - 1} onClick={props.onDown} aria-label={`${t('common.moveDown')} ${v.name}`}>
            ↓
          </button>
          <button
            type="button"
            className="icon-btn"
            disabled={v.locked}
            title={v.locked ? t('stops.lockedVisited') : undefined}
            onClick={props.onRemove}
            aria-label={`${t('stops.remove')} ${v.name}`}
          >
            ✕
          </button>
        </div>
      ) : (
        <span />
      )}
    </div>
  );
}
