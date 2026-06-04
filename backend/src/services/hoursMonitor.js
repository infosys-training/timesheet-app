const { getDatabase } = require('../database/init');
const { sendEmail } = require('./emailService');

const WEEKLY_HOUR_THRESHOLD = parseFloat(process.env.HOUR_THRESHOLD || '40');
const ALERT_RECIPIENT = process.env.ALERT_EMAIL || 'Jorawer_mann@infosys.com';

function getWeekBounds(referenceDate) {
  const d = new Date(referenceDate);
  const day = d.getUTCDay();
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - ((day + 6) % 7));
  monday.setUTCHours(0, 0, 0, 0);

  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  sunday.setUTCHours(23, 59, 59, 999);

  const fmt = (dt) => dt.toISOString().slice(0, 10);
  return { weekStart: fmt(monday), weekEnd: fmt(sunday) };
}

function getWeeklyHours(userEmail, weekStart, weekEnd) {
  return new Promise((resolve, reject) => {
    const db = getDatabase();
    db.all(
      `SELECT we.hours, we.description, we.date, c.name AS client_name
       FROM work_entries we
       JOIN clients c ON we.client_id = c.id
       WHERE we.user_email = ? AND we.date BETWEEN ? AND ?
       ORDER BY we.date ASC`,
      [userEmail, weekStart, weekEnd],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      }
    );
  });
}

function buildReportHtml(userEmail, totalHours, entries, weekStart, weekEnd) {
  const clientMap = {};
  for (const e of entries) {
    if (!clientMap[e.client_name]) clientMap[e.client_name] = 0;
    clientMap[e.client_name] += parseFloat(e.hours);
  }

  const clientBreakdown = Object.entries(clientMap)
    .map(([name, hrs]) => `<li>${name}: ${hrs.toFixed(2)} hrs</li>`)
    .join('');

  const entryRows = entries
    .map(
      (e) =>
        `<tr>
          <td>${e.date}</td>
          <td>${e.client_name}</td>
          <td>${parseFloat(e.hours).toFixed(2)}</td>
          <td>${e.description || '—'}</td>
        </tr>`
    )
    .join('');

  return `
    <h2>Weekly Hours Threshold Alert</h2>
    <p><strong>Employee:</strong> ${userEmail}</p>
    <p><strong>Week:</strong> ${weekStart} to ${weekEnd}</p>
    <p><strong>Total Hours Logged:</strong> ${totalHours.toFixed(2)} (threshold: ${WEEKLY_HOUR_THRESHOLD})</p>

    <h3>Per-Client Breakdown</h3>
    <ul>${clientBreakdown}</ul>

    <h3>Individual Entries</h3>
    <table border="1" cellpadding="4" cellspacing="0">
      <thead>
        <tr><th>Date</th><th>Client</th><th>Hours</th><th>Description</th></tr>
      </thead>
      <tbody>${entryRows}</tbody>
    </table>
  `;
}

async function checkAndAlert(userEmail, referenceDate) {
  const { weekStart, weekEnd } = getWeekBounds(referenceDate || new Date());
  const entries = await getWeeklyHours(userEmail, weekStart, weekEnd);
  const totalHours = entries.reduce((sum, e) => sum + parseFloat(e.hours), 0);

  if (totalHours <= WEEKLY_HOUR_THRESHOLD) {
    return {
      alert: false,
      totalHours,
      threshold: WEEKLY_HOUR_THRESHOLD,
      weekStart,
      weekEnd
    };
  }

  const html = buildReportHtml(userEmail, totalHours, entries, weekStart, weekEnd);
  const subject = `Hours Threshold Exceeded – ${userEmail} (${totalHours.toFixed(2)} hrs, week of ${weekStart})`;

  const emailResult = await sendEmail({
    to: ALERT_RECIPIENT,
    subject,
    html
  });

  return {
    alert: true,
    totalHours,
    threshold: WEEKLY_HOUR_THRESHOLD,
    weekStart,
    weekEnd,
    emailSentTo: ALERT_RECIPIENT,
    emailMessageId: emailResult.messageId
  };
}

module.exports = {
  checkAndAlert,
  getWeekBounds,
  getWeeklyHours,
  buildReportHtml,
  WEEKLY_HOUR_THRESHOLD,
  ALERT_RECIPIENT
};
