import type { CSSProperties } from 'react';

// Route colour palette (§9.1, R5): a route's `color` is an index 1..10 into this list. The same values
// are the CSS variables --r1 … --r10 in tokens.css. Colour is a secondary cue; the code identifies.
export const ROUTE_COLORS = [
  '#4E79A7', // 1
  '#F28E2B', // 2
  '#E15759', // 3
  '#76B7B2', // 4
  '#59A14F', // 5
  '#EDC948', // 6
  '#B07AA1', // 7
  '#FF9DA7', // 8
  '#9C755F', // 9
  '#17BECF', // 10
] as const;

export const COLOR_INDEXES = ROUTE_COLORS.map((_, i) => i + 1);

/** Hex colour of index 1..10 (anything else falls back to index 1). */
export function routeColor(index: number | null | undefined): string {
  const i = Number(index);
  return ROUTE_COLORS[(Number.isInteger(i) && i >= 1 && i <= 10 ? i : 1) - 1];
}

/** CSS value for the --rc custom property, e.g. style={{'--rc': routeColorVar(3)}}. */
export function routeColorVar(index: number | null | undefined): string {
  const i = Number(index);
  return `var(--r${Number.isInteger(i) && i >= 1 && i <= 10 ? i : 1})`;
}

/** Inline style that sets --rc for a route colour bar. */
export function rcStyle(index: number | null | undefined): CSSProperties {
  return { ['--rc' as string]: routeColorVar(index) } as CSSProperties;
}
