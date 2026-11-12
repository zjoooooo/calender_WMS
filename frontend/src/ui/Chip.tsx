// Chips and tags (§9.2): toggle chips, the R / S / ⚡A route type tag, waste-type tags and the
// route code with its colour bar.
import type { ReactNode } from 'react';
import type { RouteType } from '../api';
import { rcStyle } from './palette';

/** Toggle chip (aria-pressed). */
export function Chip(props: {
  pressed: boolean;
  onClick?: () => void;
  children: ReactNode;
  disabled?: boolean;
  title?: string;
  inactive?: boolean;
}) {
  return (
    <button
      type="button"
      className={props.inactive ? 'chip inactive' : 'chip'}
      aria-pressed={props.pressed}
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
    >
      {props.children}
    </button>
  );
}

/** Small status tag. */
export function Tag({ children, tone, title }: { children: ReactNode; tone?: 'ok' | 'warn' | 'danger' | 'ph'; title?: string }) {
  return (
    <span className={tone ? `tag ${tone}` : 'tag'} title={title}>
      {children}
    </span>
  );
}

/** Route type tag: R, S or ⚡A (§9.2). */
export function TypeTag({ type }: { type: RouteType }) {
  const label = type === 'regular' ? 'R' : type === 'special' ? 'S' : '⚡A';
  return <span className={type === 'adhoc' ? 'tt A' : 'tt'}>{label}</span>;
}

/** Waste-type tag, e.g. REL / OTC / COMPACTOR (shows the abbr when given). */
export function WasteTag({ code, abbr, inactive, title }: { code: string; abbr?: string; inactive?: boolean; title?: string }) {
  return (
    <span className={inactive ? 'wtag inactive' : 'wtag'} title={title ?? code}>
      {abbr || code}
    </span>
  );
}

/** Route code in mono with its colour bar: ▌N1. Adhoc gets the ⚡ mark. */
export function RouteCode({ code, color, type }: { code: string; color?: number | null; type?: RouteType }) {
  return (
    <span className="rcode code" style={rcStyle(color)}>
      {type === 'adhoc' ? '⚡' : ''}
      {code}
    </span>
  );
}
