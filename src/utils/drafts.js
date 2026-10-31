/**
 * Turning what was said in a meeting into drafts (MONDAY_FEATURE_SPEC.md F-MTG-05). Pure, unit-tested.
 *
 * A draft names who it is for only when the name said matches one person ("sure"). A name that was said but
 * matches nobody makes it "unsure": the review shows "Pick a person" and nothing is assigned silently.
 * A task with no name is the recorder's own ("mine").
 */

const MEETING_TASK_SHAPE = '{"tasks":[{"title":"short imperative title in English","assignee":"username of the person it is for, or null",'
  + '"assignee_said":"the name exactly as it was said, or null","quote":"the words it came from, up to 30 words",'
  + '"due_date":"YYYY-MM-DD or null","due_time":"HH:MM or null","priority":1-4 or null}]}';

const clip = (s, max) => String(s ?? '').replace(/[\u0000-\u001F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Clean the AI's tasks for one part of a meeting. `people.byUsername` maps a lower-case username to a user.
 * Up to `limit` tasks (a ten-minute meeting can set well over a hundred).
 */
function cleanMeetingTasks(list, people, ownerId, limit = 200) {
  return (Array.isArray(list) ? list : []).slice(0, limit).map((t) => {
    const title = clip(t?.title, 300);
    if (!title) return null;
    const who = t.assignee ? people.byUsername.get(String(t.assignee).replace(/^@/, '').toLowerCase()) : null;
    const said = clip(t.assignee_said, 120) || null;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(t.due_date || '') ? t.due_date : null;
    const time = date && /^\d{2}:\d{2}$/.test(t.due_time || '') ? t.due_time : null;
    const priority = [1, 2, 3, 4].includes(Number(t.priority)) ? Number(t.priority) : null;
    const forOwner = who && who.id === ownerId;
    return {
      title,
      quote: clip(t.quote, 400),
      assignee_id: who && !forOwner ? who.id : null,
      assignee_said: said,
      confidence: who ? (forOwner ? 'mine' : 'sure') : (said ? 'unsure' : 'mine'),
      due_date: date,
      due_time: time,
      priority,
    };
  }).filter(Boolean);
}

/** One draft per task title (a long meeting is read in parts, and parts overlap in what they repeat). */
function mergeTasks(parts) {
  const seen = new Map();
  for (const t of parts.flat()) {
    const key = t.title.toLowerCase();
    const had = seen.get(key);
    // Keep the most certain reading of a repeated task.
    if (!had || (had.confidence !== 'sure' && t.confidence === 'sure')) seen.set(key, t);
  }
  return [...seen.values()];
}

/**
 * Which company a draft belongs to. A named person who works in the meeting's company gets it there; someone
 * in exactly one company gets it there; anyone else gets a personal hand-over (null). The recorder's own
 * tasks go to the meeting's company, or stay personal.
 *   memberships: Map userId -> [businessId, ...]   leaders: Set of userIds who can be given work anywhere
 */
function guessBusiness({ assigneeId, meetingBusinessId = null, memberships, leaders }) {
  if (!assigneeId) return meetingBusinessId || null;
  const theirs = memberships.get(assigneeId) || [];
  if (meetingBusinessId && (theirs.includes(meetingBusinessId) || leaders.has(assigneeId))) return meetingBusinessId;
  if (theirs.length === 1) return theirs[0];
  return null;
}

/** "Kaushal 34, Nagarjuna 27, ... 6 with no clear person" for the review screen and the summary line. */
function summarizeByPerson(drafts, nameOf) {
  const byPerson = new Map();
  let unsure = 0;
  let mine = 0;
  for (const d of drafts) {
    if (d.confidence === 'unsure' && !d.assignee_id) { unsure += 1; continue; }
    if (!d.assignee_id) { mine += 1; continue; }
    byPerson.set(d.assignee_id, (byPerson.get(d.assignee_id) || 0) + 1);
  }
  const people = [...byPerson.entries()]
    .map(([id, count]) => ({ id, name: nameOf(id) || 'Someone', count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { people, unsure, mine, total: drafts.length };
}

module.exports = { MEETING_TASK_SHAPE, cleanMeetingTasks, mergeTasks, guessBusiness, summarizeByPerson };
