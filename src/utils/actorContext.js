const { AsyncLocalStorage } = require('async_hooks');

// Who is making the current request. authenticate() sets it, so notify() can tell the people it reaches who
// it came from (their cat buddy visits) without every call site passing the actor along.
const actorStore = new AsyncLocalStorage();

/** Run `fn` with `userId` as the acting person for everything it awaits. */
const runAsActor = (userId, fn) => actorStore.run({ userId }, fn);
const currentActorId = () => actorStore.getStore()?.userId || null;

module.exports = { runAsActor, currentActorId };
