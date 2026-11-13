// OFF-2: the scope dialog pre-selects "this date and all following" for a route with no customer list yet.
import { describe, expect, it } from 'vitest';
import { defaultScope } from './ScopeDialog';

describe('scope dialog default', () => {
  it('a date that inherits an empty list (a new route): this date and all following', () => {
    expect(defaultScope({ stops: [], edited: false }, 0)).toBe('following');
  });
  it('a route that already has its list, or a date with its own (even empty) list: only this date', () => {
    expect(defaultScope({ stops: [{ seq: 1, customer_id: 5, note: '', visit: null }], edited: false })).toBe('this');
    expect(defaultScope({ stops: [], edited: true }, 0)).toBe('this');
  });
  it('a date with no customer due on a route that has customers on other weekdays, or a route still loading: only this date', () => {
    expect(defaultScope({ stops: [], edited: false }, 3)).toBe('this');
    expect(defaultScope({ stops: [], edited: false }, undefined)).toBe('this');
  });
});
