const db = require('../db');
const { averageVelocity } = require('../utils/sprints');

/** Every sprint of a business with its task and point totals (one query). Active first, then planned, then finished. */
async function sprintStats(businessId) {
  return (await db.query(
    `SELECT s.id, s.name, s.goal, s.starts_on, s.ends_on, s.status, s.started_at, s.completed_at,
            COUNT(t.id)::int AS task_count,
            COUNT(t.id) FILTER (WHERE t.is_done)::int AS done_count,
            COALESCE(SUM(t.story_points), 0)::int AS total_points,
            COALESCE(SUM(t.story_points) FILTER (WHERE t.is_done), 0)::int AS done_points
     FROM sprints s
     LEFT JOIN todos t ON t.sprint_id = s.id
     WHERE s.business_id = $1
     GROUP BY s.id
     ORDER BY CASE s.status WHEN 'active' THEN 0 WHEN 'planned' THEN 1 ELSE 2 END, s.starts_on DESC, s.id DESC`,
    [businessId]
  )).rows;
}

/** Velocity: average points finished across recent completed sprints (oldest first). */
function velocityOf(rows) {
  const completed = rows
    .filter((r) => r.status === 'completed')
    .sort((a, b) => (a.completed_at > b.completed_at ? 1 : -1));
  return {
    average: averageVelocity(completed.map((r) => r.done_points)),
    completed: completed.map((r) => ({ id: r.id, name: r.name, points: r.done_points, ends_on: r.ends_on })),
  };
}

module.exports = { sprintStats, velocityOf };
