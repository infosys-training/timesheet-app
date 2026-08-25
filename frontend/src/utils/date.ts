export function formatDateOnly(value: string | number, locale?: string): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-').map(Number);
    return new Date(year, month - 1, day).toLocaleDateString(locale);
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return new Date(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate()
  ).toLocaleDateString(locale);
}
