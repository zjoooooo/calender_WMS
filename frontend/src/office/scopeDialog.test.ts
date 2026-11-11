// OFF-2: the scope dialog pre-selects "this date and all following" for a route with no customer list yet.
import { describe, expect, it } from 'vitest';
import { defaultScope } from './ScopeDialog';

describe('scope dialog default', () => {
  it('a date that inherits an empty list (a new route): this date and all following', () => {
    expect(defaultScope({ stops: [], edited: false })).toBe('following');
  });
  it('a route that already has its list, or a date with its own (even empty) list: only this date', () => {
    expect(defaultScope({ stops: [{ seq: 1, customer_id: 5, note: '', visit: null }], edited: false })).toBe('this');
    expect(defaultScope({ stops: [], edited: true })).toBe('this');
  });
});
