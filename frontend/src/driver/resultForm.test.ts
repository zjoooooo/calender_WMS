// DRV-7: a result refused with TICKET_REQUIRED reopens with that ticket field, even from an older job copy.
import { describe, expect, it } from 'vitest';
import type { JobStop } from '../api';
import type { NotSentEntry } from './outbox';
import { formStop } from './ResultForm';

const stop: JobStop = {
  seq: 1,
  on_plan: true,
  stop_note: '',
  customer: { id: 84, code: 'C084', name: 'Prime Logistics', address: '', phone: '', note: '' },
  weigh_types: ['REL'],
  ticket_types: [],
  also_on: [],
  visit: null,
};
const refused = (code: string, field: string | null) =>
  ({ id: 'x', error: { code, http: 422, message: '', field, details: null } }) as unknown as NotSentEntry;

describe('formStop', () => {
  it('adds the ticket field a TICKET_REQUIRED refusal names', () => {
    expect(formStop(stop, refused('TICKET_REQUIRED', 'tickets.REL')).ticket_types).toEqual(['REL']);
  });
  it('leaves the stop alone otherwise', () => {
    expect(formStop(stop, null)).toBe(stop);
    expect(formStop(stop, refused('NOT_HOLDER', null))).toBe(stop);
    expect(formStop(stop, refused('TICKET_REQUIRED', 'tickets.OTC'))).toBe(stop); // not a weighed type here
    const has = { ...stop, ticket_types: ['REL'] };
    expect(formStop(has, refused('TICKET_REQUIRED', 'tickets.REL'))).toBe(has);
  });
});
