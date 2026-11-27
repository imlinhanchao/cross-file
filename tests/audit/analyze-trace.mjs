/**
 * Trace analyser for the zero-storage audit (docs/01 AC8, docs/02 §7).
 *
 * Reads an `strace -f -e trace=openat,openat2,write` log produced while a real signaling session
 * ran, plus the server's stdout log, and decides whether the signaling process wrote anything to
 * disk. Called by tests/audit/zero-storage.sh; also usable on its own:
 *
 *   node tests/audit/analyze-trace.mjs --trace /tmp/trace.txt --log /tmp/server.log \
 *     --workdir /tmp/empty-cwd --client-log /tmp/client.log
 *
 * Assertions:
 *   1. no write-mode open (O_WRONLY/O_RDWR/O_CREAT/O_TRUNC/O_APPEND/O_TMPFILE) outside /dev, /proc,
 *      /sys — i.e. the process opened no file it could write to;
 *   2. no write(2) to an fd that belongs to a regular file (stdout/stderr fds 1/2 are excluded;
 *      sockets and pipes are not file writes);
 *   3. no database-ish path is opened at all;
 *   4. server stdout is exactly the one startup line (no access log, no request log), and
 *      session secrets observed by the client (roomId, 6-digit code, display names) never
 *      appear in it;
 *   5. the client session actually succeeded and the process cwd stayed empty.
 *
 * Exit code 0 = PASS, 1 = FAIL.
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/** Sensitive values the client saw: `CLIENT WATCH key=value` lines from signal-client.mts. */
function readWatchValues(path) {
  if (!path) return [];
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const values = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^CLIENT WATCH ([^=]+)=(.*)$/);
    if (match) values.push({ label: match[1], value: match[2] });
  }
  return values;
}

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] !== undefined
    ? process.argv[index + 1]
    : fallback;
}

const tracePath = arg("--trace");
const logPath = arg("--log");
const workdir = arg("--workdir");
const clientLogPath = arg("--client-log");
const excludeDevProcSys = true;

if (!tracePath) {
  console.error(
    "usage: analyze-trace.mjs --trace <strace-file> [--log <server-log>] [--workdir <dir>] [--client-log <file>]",
  );
  process.exit(1);
}

const results = [];
let failed = false;

function pass(label, evidence) {
  console.log(`[PASS] ${label}`);
  if (evidence) console.log(`[EVIDENCE] ${evidence}`);
}
function fail(label, evidence, samples = []) {
  failed = true;
  console.log(`[FAIL] ${label}`);
  if (evidence) console.log(`[EVIDENCE] ${evidence}`);
  for (const sample of samples.slice(0, 5))
    console.log(`[EVIDENCE]   ${sample.slice(0, 300)}`);
}
function note(label, evidence) {
  console.log(`[EVIDENCE] ${label}${evidence ? `: ${evidence}` : ""}`);
}

let trace;
try {
  trace = readFileSync(tracePath, "utf8");
} catch (error) {
  console.error(`[FAIL] cannot read trace ${tracePath}: ${error.message}`);
  process.exit(1);
}
const lines = trace.split("\n").filter((line) => line.trim().length > 0);
if (lines.length === 0) {
  console.error(
    `[FAIL] trace ${tracePath} is empty; strace did not capture the server`,
  );
  process.exit(1);
}

const WRITE_MODE = /O_WRONLY|O_RDWR|O_CREAT|O_TRUNC|O_APPEND|O_TMPFILE/;
const DB_PATH =
  /(?:\.(?:db|db-wal|db-shm|sqlite|sqlite3|mdb|rdb|aof|lmdb)|leveldb|wiredtiger|pg_wal|mysql|postgres|mongodb|rocksdb)(?:$|["/._-])/i;
const OPEN_RE = /openat2?\([^,]+, "((?:[^"\\]|\\.)*)"(.*)$/;

const writableOpens = [];
const dbOpens = [];
const writableFds = new Map(); // fd -> path (only completed write-mode opens)
const writeCalls = [];
const writeCallsByFd = new Map();
let stdWrites = 0;
let otherFdWrites = 0;

for (const line of lines) {
  const open = line.match(OPEN_RE);
  if (open) {
    const path = open[1];
    const rest = open[2] ?? "";
    const fdMatch = rest.match(/\)\s+=\s+(-?\d+)/);
    const fd = fdMatch ? Number(fdMatch[1]) : -1;

    if (DB_PATH.test(path)) dbOpens.push(line);

    if (WRITE_MODE.test(rest)) {
      const excluded =
        excludeDevProcSys &&
        (path.startsWith("/dev/") ||
          path.startsWith("/proc/") ||
          path.startsWith("/sys/"));
      if (!excluded) writableOpens.push(line);
      if (fd >= 0) writableFds.set(fd, path);
    }
    continue;
  }

  const write = line.match(/(?:^|\s)write\((\d+),/);
  if (write) {
    const fd = Number(write[1]);
    writeCalls.push(line);
    writeCallsByFd.set(fd, (writeCallsByFd.get(fd) ?? 0) + 1);
    if (fd <= 2) {
      stdWrites += 1;
    } else if (writableFds.has(fd)) {
      // The fd came from a write-mode open of a regular file: content reached the disk.
      writableOpens.push(line);
    } else {
      otherFdWrites += 1;
    }
  }
}

// 1. No writable file opens.
if (writableOpens.length === 0) {
  pass(
    "signaling process opened no writable file (no O_WRONLY/O_RDWR/O_CREAT/O_TRUNC/O_APPEND/O_TMPFILE)",
  );
} else {
  fail(
    `signaling process opened ${writableOpens.length} writable file(s)`,
    `${writableOpens.length} offending syscall(s)`,
    writableOpens,
  );
}

// 2. Explicitly report write() calls so the evidence is readable, not just an absence.
const fileWrites = writeCalls.filter((line) => {
  const match = line.match(/(?:^|\s)write\((\d+),/);
  return match
    ? Number(match[1]) > 2 && writableFds.has(Number(match[1]))
    : false;
});
if (fileWrites.length === 0) {
  pass(
    `no write(2) reached a file opened for writing (${stdWrites} write(s) to stdout/stderr, ${otherFdWrites} to sockets/pipes)`,
  );
} else {
  fail(
    `signaling process wrote ${fileWrites.length} time(s) to a regular-file fd`,
    "",
    fileWrites,
  );
}

// 3. No database file touched.
if (dbOpens.length === 0) {
  pass(
    "no database file path was opened (no *.db / sqlite / leveldb / redis / postgres artefacts)",
  );
} else {
  fail(
    `signaling process opened ${dbOpens.length} database-looking path(s)`,
    "",
    dbOpens,
  );
}

// 4. Server stdout: exactly one startup line.
if (logPath) {
  let log = "";
  try {
    log = readFileSync(logPath, "utf8");
  } catch (error) {
    fail(`cannot read server log ${logPath}: ${error.message}`);
  }
  if (log) {
    const logLines = log.split("\n").filter((line) => line.trim().length > 0);
    const startup = logLines[0] ?? "";
    if (
      logLines.length === 1 &&
      startup.startsWith("[crossfile-signaling] listening")
    ) {
      pass(`server stdout has exactly 1 line, the startup line: ${startup}`);
    } else {
      fail(
        `server stdout has ${logLines.length} non-empty line(s); expected only the startup line`,
        "",
        logLines,
      );
    }
    const accessLog = logLines.filter((line) =>
      /\b(GET|POST|UPGRADE)\b|\b20\d\d-\d\d-\d\dT|access log/i.test(line),
    );
    if (accessLog.length === 0) {
      pass("no HTTP/access-log lines on stdout");
    } else {
      fail(
        `found ${accessLog.length} access-log-looking line(s)`,
        "",
        accessLog,
      );
    }

    // 4b. The server must not echo session secrets it can see (docs/02 §7: logs never carry
    // roomId/display names; the 6-digit code is a room secret too). signal-client.mts prints
    // every value it learned as `CLIENT WATCH key=value`.
    const watch = readWatchValues(clientLogPath);
    if (watch.length === 0) {
      note(
        "client log has no CLIENT WATCH values; skipped the stdout-leak assertion",
      );
    } else {
      const leaked = watch.filter((entry) => log.includes(entry.value));
      if (leaked.length === 0) {
        pass(
          `server stdout contains none of the ${watch.length} client-visible secret(s) (roomId/code/display names)`,
        );
      } else {
        fail(
          `server stdout leaked ${leaked.length} client-visible secret(s)`,
          leaked.map((entry) => `${entry.label}=${entry.value}`).join(", "),
        );
      }
    }
  }
}

// 5. Client session succeeded.
if (clientLogPath) {
  let clientLog = "";
  try {
    clientLog = readFileSync(clientLogPath, "utf8");
  } catch (error) {
    fail(`cannot read client log ${clientLogPath}: ${error.message}`);
  }
  if (clientLog.includes("CLIENT PASS")) {
    const steps = clientLog
      .split("\n")
      .filter((line) => line.startsWith("CLIENT OK")).length;
    pass(
      `real signaling session completed through the audited process (${steps} steps, CLIENT PASS)`,
    );
  } else {
    fail(
      "signaling client session did not pass; the trace may not cover real traffic",
      "",
      clientLog.split("\n"),
    );
  }
}

// 6. The process cwd stayed empty (a crash dump, cache or db would show up here).
if (workdir) {
  let entries = [];
  try {
    entries = readdirSync(resolve(workdir));
  } catch (error) {
    fail(`cannot list audited workdir ${workdir}: ${error.message}`);
  }
  if (entries.length === 0) {
    pass(`process working directory stayed empty (${resolve(workdir)})`);
  } else {
    fail(
      `process working directory gained ${entries.length} entry(ies)`,
      entries.join(", "),
    );
  }
}

if (failed) {
  console.log("RESULT FAIL");
  process.exit(1);
}
console.log("RESULT PASS");
process.exit(0);
