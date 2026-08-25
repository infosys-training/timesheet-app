const DATE_ONLY_SQL = "date(CASE WHEN typeof(date) IN ('integer','real') THEN datetime(date/1000, 'unixepoch') ELSE date END)";

function toDateOnly(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }

  let date;
  if (value instanceof Date) {
    date = value;
  } else if (
    (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))
  ) {
    date = new Date(Number(value));
  } else if (typeof value === 'string') {
    date = new Date(value);
  }

  if (!date || Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toISOString().slice(0, 10);
}

function isValidDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function parseDateRange(query) {
  const { startDate, endDate } = query || {};
  for (const [name, value] of [['startDate', startDate], ['endDate', endDate]]) {
    if (value !== undefined && (!isValidDateOnly(value))) {
      return { error: `Invalid ${name}: expected a real date in YYYY-MM-DD format` };
    }
  }

  if (startDate !== undefined && endDate !== undefined && startDate > endDate) {
    return { error: 'Invalid date range: startDate must be on or before endDate' };
  }

  return { startDate, endDate };
}

module.exports = { toDateOnly, DATE_ONLY_SQL, parseDateRange };
