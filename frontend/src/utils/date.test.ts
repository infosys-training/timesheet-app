import { describe, expect, it } from 'vitest';
import { formatDateOnly, parseDateOnly, toDateOnlyString } from './date';

describe('formatDateOnly', () => {
  it('formats date-only strings without a timezone shift', () => {
    expect(formatDateOnly('2024-01-15', 'en-US')).toBe('1/15/2024');
  });

  it('keeps a picked local calendar date when serializing', () => {
    expect(toDateOnlyString(new Date(2024, 0, 15))).toBe('2024-01-15');
  });

  it('round-trips date-only strings and UTC epoch dates', () => {
    const dateOnly = parseDateOnly('2024-01-15');
    expect([dateOnly.getFullYear(), dateOnly.getMonth(), dateOnly.getDate()]).toEqual([2024, 0, 15]);

    const epochDate = parseDateOnly(Date.UTC(2024, 0, 15));
    expect([epochDate.getFullYear(), epochDate.getMonth(), epochDate.getDate()]).toEqual([2024, 0, 15]);
  });
});
