/**
 * schedulingEngine.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Day-wise task scheduling engine.
 *
 * Rules:
 *  - Tasks for the SAME role → sequential (one after the other)
 *  - Tasks for DIFFERENT roles → parallel (each role starts from project start_date)
 *  - Skips weekends (Saturday = 6, Sunday = 0) — work days only
 *  - Each task gets a start_date, end_date, and due_date
 *
 * Input:  flat array of task drafts + project start date
 * Output: same array with start_date, end_date, due_date filled in
 */

/**
 * Advance a date by N working days (skipping Sat/Sun).
 *
 * @param {Date}   from  - Start date
 * @param {number} days  - Number of working days to add
 * @returns {Date}
 */
function addWorkingDays(from, days) {
  const date = new Date(from);
  let added = 0;
  while (added < days) {
    date.setDate(date.getDate() + 1);
    const dow = date.getDay();
    if (dow !== 0 && dow !== 6) added++; // skip Sunday(0) and Saturday(6)
  }
  return date;
}

/**
 * Get the next working day from a given date (if date itself is a weekend, move to Monday).
 *
 * @param {Date} date
 * @returns {Date}
 */
function nextWorkingDay(date) {
  const d = new Date(date);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
  }
  return d;
}

/**
 * Schedule tasks with day-wise start/end dates.
 *
 * Each unique role gets its own independent timeline cursor starting from
 * projectStartDate. This means frontend tasks, backend tasks, designer tasks
 * all run in parallel — but tasks within the same role are sequential.
 *
 * @param {Object[]} taskDrafts        - Flat array of task objects (must have required_role, estimated_days)
 * @param {Date|string} projectStartDate - Project start date
 * @returns {Object[]}  Same tasks with start_date, end_date, due_date added
 */
function scheduleTasks(taskDrafts, projectStartDate) {
  const baseDate = nextWorkingDay(new Date(projectStartDate));

  // Track the "next available day" cursor per role
  // Key: required_role (string), Value: Date (cursor)
  const roleCursors = {};

  const scheduled = taskDrafts.map((draft) => {
    const role = (draft.required_role || "general").toLowerCase().trim();
    const estimatedDays = draft.estimated_days || 1;

    // If this role has no cursor yet, start from project start date
    if (!roleCursors[role]) {
      roleCursors[role] = new Date(baseDate);
    }

    const taskStart = new Date(roleCursors[role]);
    const taskEnd   = addWorkingDays(taskStart, estimatedDays);

    // Advance cursor: next task for this role starts the day after this one ends
    const nextStart = new Date(taskEnd);
    nextStart.setDate(nextStart.getDate() + 1);
    roleCursors[role] = nextWorkingDay(nextStart);

    return {
      ...draft,
      start_date: taskStart,
      end_date:   taskEnd,
      due_date:   taskEnd, // due_date mirrors end_date for backward compat
    };
  });

  return scheduled;
}

/**
 * Reschedule tasks for a specific role when a new project is added.
 *
 * When new tasks are added to an existing user's schedule, we need to
 * find when they are already free and slot new tasks after that.
 *
 * @param {Object[]} newTaskDrafts      - New task drafts to schedule
 * @param {Date}     projectStartDate   - New project start date
 * @param {Object}   existingWorkload   - Map of role → latest end_date from all current tasks
 *                                        { "frontend developer": Date, "backend developer": Date, ... }
 * @returns {Object[]} newTaskDrafts with start_date/end_date filled
 */
function scheduleTasksWithWorkload(newTaskDrafts, projectStartDate, existingWorkload = {}) {
  const baseDate = nextWorkingDay(new Date(projectStartDate));

  // Role cursors start at: max(projectStartDate, user's current latest task end_date)
  const roleCursors = {};

  const scheduled = newTaskDrafts.map((draft) => {
    const role = (draft.required_role || "general").toLowerCase().trim();
    const estimatedDays = draft.estimated_days || 1;

    if (!roleCursors[role]) {
      // If the user already has tasks ending after the project start, wait for them to finish
      const existingEnd = existingWorkload[role];
      if (existingEnd && new Date(existingEnd) > baseDate) {
        const afterExisting = new Date(existingEnd);
        afterExisting.setDate(afterExisting.getDate() + 1);
        roleCursors[role] = nextWorkingDay(afterExisting);
      } else {
        roleCursors[role] = new Date(baseDate);
      }
    }

    const taskStart = new Date(roleCursors[role]);
    const taskEnd   = addWorkingDays(taskStart, estimatedDays);

    const nextStart = new Date(taskEnd);
    nextStart.setDate(nextStart.getDate() + 1);
    roleCursors[role] = nextWorkingDay(nextStart);

    return {
      ...draft,
      start_date: taskStart,
      end_date:   taskEnd,
      due_date:   taskEnd,
    };
  });

  return scheduled;
}

/**
 * Get the latest end_date per role for a given user's active tasks.
 * Used to determine when the user is "free" before assigning new project tasks.
 *
 * @param {Object[]} activeTasks - Array of task documents from DB (must have required_role, end_date)
 * @returns {Object} Map: { "frontend developer": Date, ... }
 */
function getUserRoleEndDates(activeTasks) {
  const roleEndDates = {};

  for (const task of activeTasks) {
    if (!task.end_date) continue;
    const role = (task.required_role || "general").toLowerCase().trim();
    const taskEnd = new Date(task.end_date);
    if (!roleEndDates[role] || taskEnd > roleEndDates[role]) {
      roleEndDates[role] = taskEnd;
    }
  }

  return roleEndDates;
}

module.exports = {
  scheduleTasks,
  scheduleTasksWithWorkload,
  getUserRoleEndDates,
  addWorkingDays,
  nextWorkingDay,
};
