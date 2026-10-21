// Creates a Google Meet link by putting an event with a conference on the company's Google Calendar.
// Needs one Google account's OAuth client: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
// (scope https://www.googleapis.com/auth/calendar.events). Without them meetings are reported as not set up.

const configured = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN);

let cached = { token: null, until: 0 };

async function accessToken() {
  if (cached.token && Date.now() < cached.until) return cached.token;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new Error(data.error_description || 'Google sign-in failed');
  cached = { token: data.access_token, until: Date.now() + (Number(data.expires_in || 3000) - 120) * 1000 };
  return cached.token;
}

/** -> { url, eventId }. `attendees` are e-mail addresses (they get a calendar invite). */
async function createMeet({ title, description, start, end, attendees = [], requestId }) {
  if (!configured()) {
    const err = new Error('Google Meet is not connected yet. Ask the owner to add the Google credentials.');
    err.status = 503;
    throw err;
  }
  const token = await accessToken();
  const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      summary: title,
      description: description || '',
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
      attendees: attendees.map((email) => ({ email })),
      conferenceData: { createRequest: { requestId, conferenceSolutionKey: { type: 'hangoutsMeet' } } },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || 'Google could not create the meeting');
  const url = data.hangoutLink || data.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri;
  if (!url) throw new Error('Google did not return a Meet link');
  return { url, eventId: data.id };
}

module.exports = { createMeet, configured };
