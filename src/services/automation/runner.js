/**
 * Runs a task: an ordered list of actions with If / Else, Repeat, Wait, Jump and "run another task".
 * Everything that touches the outside world (the database, notifications, other people) is done through
 * `deps.exec`, so the flow rules here can be unit-tested with a fake. Limits keep any run bounded.
 */
const { ACTIONS, analyzeBlocks } = require('../../utils/automation/catalog');
const { interpolate, evaluate, evalComparison, asText, ExprError, toNum, safeRegex } = require('../../utils/automation/expr');

const LIMITS = {
  steps: 1000,
  loopItems: 200,
  runMs: 90 * 1000,
  waitMsTotal: 120 * 1000,
  depth: 3,
  logEntries: 150,
};

class RunLimit extends Error {}
class StopTask extends Error {}

const GLOBAL_NAME = /^[A-Z][A-Z0-9_]*$/;
const isGlobalName = (name) => GLOBAL_NAME.test(name);
const cleanName = (name) => String(name || '').trim().replace(/^%/, '');

/** Variables a run always has: the clock and who is running it. */
function builtins({ now, owner, trigger }) {
  const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][now.dow];
  return {
    TIME: now.hm,
    DATE: now.date,
    DAY: day,
    HOUR: Number(now.hm.slice(0, 2)),
    MIN: Number(now.hm.slice(3, 5)),
    WEEKDAY: now.dow === 0 ? 7 : now.dow,
    TODAY: now.date,
    TOMORROW: now.tomorrow,
    USER: owner.name,
    USERID: owner.id,
    trigger,
  };
}

/**
 * @param {object} args
 *   task        { id, name, actions }
 *   rt          shared runtime for the whole run (see makeRuntime): vars, budget, log
 *   deps        { exec(type, params, rt), loadTask(id), sleep(ms) }
 *   depth       how deep "run another task" has gone
 */
async function runActions(actions, rt, deps, { depth = 0, locals } = {}) {
  const blocks = analyzeBlocks(actions);
  if (blocks.errors.length) throw new Error(blocks.errors[0].message);
  const labels = new Map();
  actions.forEach((a, i) => { if (a.type === 'label') labels.set(a.name, i); });

  const scope = locals || new Map();
  const lookup = (name) => {
    if (scope.has(name)) return scope.get(name);
    return rt.lookup(name);
  };
  const setVar = (rawName, value) => {
    const name = cleanName(rawName);
    if (isGlobalName(name)) rt.setGlobal(name, value);
    else scope.set(name, value);
  };
  const frames = [];
  let result = '';
  let pc = 0;
  let landed = -1; // index of an Else if / Else we jumped to because the branch before it was not taken

  const tick = () => {
    rt.steps += 1;
    if (rt.steps > LIMITS.steps) throw new RunLimit('This run did too many steps and was stopped');
    if (Date.now() - rt.startedAt > LIMITS.runMs) throw new RunLimit('This run took too long and was stopped');
  };

  const condition = (a) => {
    try { return evalComparison(a.cond || {}, lookup); } catch (err) {
      if (err instanceof ExprError) throw new Error(`Condition: ${err.message}`);
      throw err;
    }
  };

  const loopItems = (a) => {
    if (a.mode === 'each') {
      const raw = String(a.list || '').trim();
      const direct = /^%([A-Za-z_][A-Za-z0-9_]*)$/.exec(raw);
      let list = direct ? lookup(direct[1]) : interpolate(raw, lookup);
      if (!Array.isArray(list)) list = asText(list) === '' ? [] : asText(list).split(',').map((s) => s.trim());
      return list.slice(0, LIMITS.loopItems);
    }
    const n = Math.max(0, Math.min(LIMITS.loopItems, Math.trunc(toNum(interpolate(String(a.times ?? '1'), lookup)) || 0)));
    return Array.from({ length: n }, (_, i) => i + 1);
  };
  const bindLoop = (frame) => {
    setVar(frame.varName, frame.items[frame.idx]);
    setVar(`${frame.varName}_index`, frame.idx + 1);
  };

  while (pc < actions.length) {
    const a = actions[pc];
    tick();
    const spec = ACTIONS[a.type];
    const at = pc;

    if (a.disabled) { pc += 1; continue; }

    if (a.type === 'if') {
      const ok = condition(a);
      rt.step(at, a.type, ok ? 'yes' : 'no');
      if (ok) pc += 1; else { pc = blocks.nextBranch[at]; landed = pc; }
      continue;
    }
    if (a.type === 'elseif') {
      if (landed !== at) { pc = blocks.endOf[at]; continue; }
      landed = -1;
      const ok = condition(a);
      rt.step(at, a.type, ok ? 'yes' : 'no');
      if (ok) pc += 1; else { pc = blocks.nextBranch[at]; landed = pc; }
      continue;
    }
    if (a.type === 'else') {
      if (landed !== at) { pc = blocks.endOf[at]; continue; }
      landed = -1; pc += 1; continue;
    }
    if (a.type === 'end_if') { pc += 1; continue; }
    if (a.type === 'for') {
      const items = loopItems(a);
      rt.step(at, a.type, `${items.length} time${items.length === 1 ? '' : 's'}`);
      if (!items.length) { pc = blocks.endOf[at] + 1; continue; }
      const frame = { start: at, items, idx: 0, varName: cleanName(a.var) || 'item' };
      frames.push(frame); bindLoop(frame); pc += 1; continue;
    }
    if (a.type === 'end_for') {
      const frame = frames[frames.length - 1];
      frame.idx += 1;
      if (frame.idx < frame.items.length) { bindLoop(frame); pc = frame.start + 1; } else { frames.pop(); pc += 1; }
      continue;
    }
    if (a.type === 'label') { pc += 1; continue; }

    // Everything below can have an "Only if" and takes its text fields with %variables filled in.
    if (a.when && !(() => { try { return evaluate(a.when, lookup); } catch (err) { throw new Error(`Only if: ${err.message}`); } })()) {
      rt.step(at, a.type, 'skipped');
      pc += 1; continue;
    }
    const params = { ...a };
    for (const f of spec.fields) {
      if (typeof params[f.key] === 'string' && !f.raw && f.type !== 'cond') params[f.key] = interpolate(params[f.key], lookup);
    }

    if (a.type === 'break') {
      const frame = frames.pop();
      rt.step(at, a.type, '');
      pc = blocks.endOf[frame.start] + 1; continue;
    }
    if (a.type === 'stop') { rt.step(at, a.type, 'stopped'); throw new StopTask(); }
    if (a.type === 'return') { result = params.value; rt.step(at, a.type, asText(result).slice(0, 80)); break; }
    if (a.type === 'goto') {
      if (!labels.has(a.name)) throw new Error(`There is no label called "${a.name}"`);
      const target = labels.get(a.name);
      rt.step(at, a.type, a.name);
      while (frames.length && !(frames[frames.length - 1].start < target && target < blocks.endOf[frames[frames.length - 1].start])) frames.pop();
      pc = target; continue;
    }
    if (a.type === 'wait') {
      const ms = Math.max(1, Math.min(60, Math.trunc(toNum(params.seconds) || 1))) * 1000;
      rt.waited += ms;
      if (rt.waited > LIMITS.waitMsTotal) throw new RunLimit('This run waited too long and was stopped');
      rt.step(at, a.type, `${ms / 1000}s`);
      await deps.sleep(ms); pc += 1; continue;
    }
    if (a.type === 'set_var') {
      const name = cleanName(params.name);
      let value;
      if (a.calculate) {
        try { value = evaluate(a.value, lookup); } catch (err) { throw new Error(`Calculation: ${err.message}`); }
      } else value = params.value;
      setVar(name, value);
      rt.step(at, a.type, `${name} = ${asText(value).slice(0, 60)}`);
      pc += 1; continue;
    }
    if (a.type === 'clear_var') {
      const name = cleanName(params.name);
      if (isGlobalName(name)) rt.clearGlobal(name); else scope.delete(name);
      rt.step(at, a.type, name); pc += 1; continue;
    }
    if (a.type === 'var_split') {
      const sep = params.sep === '' ? ',' : params.sep;
      const text = asText(params.from);
      setVar(params.name, text === '' ? [] : text.split(sep));
      rt.step(at, a.type, cleanName(params.name)); pc += 1; continue;
    }
    if (a.type === 'var_join') {
      const direct = /^%([A-Za-z_][A-Za-z0-9_]*)$/.exec(String(a.list || '').trim());
      const raw = direct ? lookup(direct[1]) : params.list;
      const list = Array.isArray(raw) ? raw : (asText(raw) === '' ? [] : asText(raw).split(','));
      setVar(params.name, list.map(asText).join(params.sep));
      rt.step(at, a.type, cleanName(params.name)); pc += 1; continue;
    }
    if (a.type === 'var_replace') {
      const name = cleanName(params.name);
      const current = asText(lookup(name));
      let next;
      if (a.regex) {
        next = current.replace(safeRegex(params.find, 'gi'), params.replace);
      } else next = current.split(params.find).join(params.replace);
      setVar(name, next); rt.step(at, a.type, name); pc += 1; continue;
    }
    if (a.type === 'log') { rt.step(at, a.type, asText(params.message).slice(0, 200)); pc += 1; continue; }
    if (a.type === 'perform_task') {
      if (depth + 1 > LIMITS.depth) throw new RunLimit('Tasks were nested too deeply');
      const task = await deps.loadTask(Number(params.task_id));
      if (!task) throw new Error('The task to run could not be found');
      rt.step(at, a.type, task.name);
      const inner = new Map([['par1', params.par1 ?? ''], ['par2', params.par2 ?? '']]);
      const out = await runActions(task.actions, rt, deps, { depth: depth + 1, locals: inner });
      if (a.into) setVar(a.into, out);
      pc += 1; continue;
    }

    // An action that does something in the world.
    const outcome = await deps.exec(a.type, params, { ...rt.api, setVar, lookup, scope });
    rt.step(at, a.type, outcome?.note || 'done');
    pc += 1;
  }
  return result;
}

/** A run's shared state: global variables, the step log and the limits it is counted against. */
function makeRuntime({ owner, trigger, now, globals = {}, initial = {}, api = {} }) {
  const globalVars = new Map(Object.entries(globals));
  const dirty = new Set();
  const removed = new Set();
  const fixed = builtins({ now, owner, trigger });
  const initialVars = new Map(Object.entries(initial));
  const rt = {
    startedAt: Date.now(),
    steps: 0,
    waited: 0,
    log: [],
    api: { ...api, owner, spent: { messages: 0, http: 0, changes: 0 } },
    lookup(name) {
      if (name in fixed) return fixed[name];
      if (initialVars.has(name)) return initialVars.get(name);
      if (globalVars.has(name)) return globalVars.get(name);
      return undefined;
    },
    setGlobal(name, value) { globalVars.set(name, Array.isArray(value) ? value.join(',') : value); dirty.add(name); removed.delete(name); },
    clearGlobal(name) { globalVars.delete(name); dirty.delete(name); removed.add(name); },
    step(index, type, note) {
      if (rt.log.length < LIMITS.logEntries) rt.log.push({ i: index, t: type, n: String(note ?? '').slice(0, 200) });
    },
    changedGlobals() { return { set: [...dirty].map((n) => [n, asText(globalVars.get(n))]), removed: [...removed] }; },
  };
  rt.initial = initialVars;
  return rt;
}

/** Runs one task start to finish and reports how it went. Never throws. */
async function runTask({ task, owner, trigger, now, globals, initial, deps, api }) {
  const rt = makeRuntime({ owner, trigger, now, globals, initial, api });
  let status = 'ok';
  let error = null;
  try {
    await runActions(task.actions, rt, deps);
  } catch (err) {
    if (err instanceof StopTask) status = 'ok';
    else if (err instanceof RunLimit) { status = 'limit'; error = err.message; } else { status = 'error'; error = err.message; }
  }
  return { status, error, steps: rt.steps, log: rt.log, durationMs: Date.now() - rt.startedAt, globals: rt.changedGlobals() };
}

module.exports = { runTask, runActions, makeRuntime, builtins, LIMITS, isGlobalName, RunLimit };
