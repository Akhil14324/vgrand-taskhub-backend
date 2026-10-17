/**
 * A tiny in-process event bus that lets the rest of the server say "this happened" without knowing about
 * automations. Publishing never throws and never waits: a slow or broken automation cannot slow a to-do
 * being saved. The AsyncLocalStorage remembers when an event was caused by an automation, so automations
 * cannot set each other off in a loop.
 */
const { EventEmitter } = require('events');
const { AsyncLocalStorage } = require('async_hooks');

const bus = new EventEmitter();
bus.setMaxListeners(20);
const als = new AsyncLocalStorage();

/** { chain: [profileId, ...], depth } when called from inside an automation run, else undefined. */
const currentRun = () => als.getStore();

function publish(event, payload) {
  try {
    bus.emit(event, { ...payload, via: currentRun() || null });
  } catch (err) {
    console.error('[automation] bus listener failed:', err.message);
  }
}

module.exports = { bus, als, publish, currentRun };
