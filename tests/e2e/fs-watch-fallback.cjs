/**
 * Sandbox fallback for environments that block inotify (this CI host returns
 * EMFILE from `inotify_init`), which makes `fs.watch()` throw and aborts the
 * Vite dev server that Playwright starts.
 *
 * When `fs.watch` fails with EMFILE/ENOSPC we fall back to a small polling
 * watcher. Chokidar only needs a `change`/`rename` event when a watched file
 * changes, which a 500 ms stat-poll provides; HMR stays functional, just a bit
 * slower. On a normal host the real `fs.watch` is used and this file is a no-op.
 *
 * Load it for the Playwright run so the spawned dev server inherits it:
 *   NODE_OPTIONS='--require ./tests/e2e/fs-watch-fallback.cjs' pnpm exec playwright test
 */
const fs = require("node:fs");
const { EventEmitter } = require("node:events");

const realWatch = fs.watch.bind(fs);
const timers = new Set();
let exitHookInstalled = false;

function statsOf(target) {
  try {
    const stat = fs.statSync(target);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "missing";
  }
}

fs.watch = function watch(target, options, listener) {
  if (typeof options === "function") {
    listener = options;
    options = {};
  }
  try {
    return realWatch(target, options, listener);
  } catch (error) {
    if (!error || (error.code !== "EMFILE" && error.code !== "ENOSPC"))
      throw error;
  }

  const emitter = new EventEmitter();
  let last = statsOf(target);
  const timer = setInterval(() => {
    const next = statsOf(target);
    if (next === last) return;
    last = next;
    emitter.emit("change", "change", String(target));
    emitter.emit("rename", "change", String(target));
  }, 500);
  timer.unref?.();
  timers.add(timer);
  emitter.close = () => {
    clearInterval(timer);
    timers.delete(timer);
  };
  emitter.unref = () => timer.unref?.();
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", () => {
      for (const pending of timers) clearInterval(pending);
      timers.clear();
    });
  }
  return emitter;
};
