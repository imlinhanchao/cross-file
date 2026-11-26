/**
 * AC4 cross-machine admin loop: keeps a room alive and publishes the join link on
 * the LAN so a remote member can fetch it at any time.
 *
 * - writes .cache/ac4-link.txt and .cache/share/link.txt (served on :8099)
 * - waits for exactly one member, approves it, sends the file, prints the result
 * - if no member arrives within the window, closes the room and opens a new one
 *
 * Run: node scripts/ac4-host-loop.mjs [sizeMB]
 */
import { chromium } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const SIZE_MB = Number(process.argv[2] ?? 100);
const BASE = process.env.AC4_BASE_URL ?? "https://room.net.time-pack.com";
const GUEST_WAIT_MS = Number(process.env.AC4_GUEST_WAIT_MS ?? 240_000);
const QUERY = process.env.AC4_QUERY ?? "debug=1";
const SIZE = SIZE_MB * 1024 * 1024;
const bytes = randomBytes(SIZE);
const expected = createHash("sha256").update(bytes).digest("hex");

const cache = resolve(".cache");
const share = resolve(cache, "share");
mkdirSync(share, { recursive: true });
const fixture = resolve(cache, `ac4-${SIZE_MB}mb.bin`);
writeFileSync(fixture, bytes);

function publish(link) {
  for (const file of [
    resolve(cache, "ac4-link.txt"),
    resolve(share, "link.txt"),
  ]) {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, link);
    renameSync(tmp, file);
  }
}

function clearPublished() {
  for (const file of [
    resolve(cache, "ac4-link.txt"),
    resolve(share, "link.txt"),
  ]) {
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, "");
    renameSync(tmp, file);
  }
}

console.log(`expected sha256: ${expected} (${SIZE} bytes)`);

// Cross-machine ICE needs a real LAN host candidate: Chrome otherwise obfuscates
// local IPs as mDNS "*.local", which a member on another machine cannot resolve
// (no TURN / same public IP => no srflx fallback). Opt out of that obfuscation.
// Playwright (1.65.1) already injects its own --disable-features list; Chromium
// keeps only the last occurrence, so replay Playwright's entries here and append
// ours instead of silently dropping them.
const CHROME_DISABLED_FEATURES = [
  // @playwright/test 1.65.1 defaults (playwright-core chromiumSwitches).
  "AvoidUnnecessaryBeforeUnloadCheckSync",
  "DestroyProfileOnBrowserClose",
  "HttpsUpgrades",
  "HttpsFirstBalancedModeAutoEnable",
  "LensOverlay",
  "MediaRouter",
  "PaintHolding",
  "ThirdPartyStoragePartitioning",
  "AvoidCorsURLLoaderRestartOnRedirect",
  "TcpPortRandomizationWin",
  "OptimizationHints",
  "NetworkTimeServiceQuerying",
  "AimEnabled",
  "PreconnectToSearch",
  "msForceBrowserSignIn",
  "msEdgeUpdateLaunchServicesPreferredVersion",
  // AC4: expose 192.168.50.200:port as a host candidate for the iOS member.
  "WebRtcHideLocalIpsWithMdns",
];

const browser = await chromium.launch({
  channel: "chrome",
  args: [`--disable-features=${CHROME_DISABLED_FEATURES.join(",")}`],
});

for (let round = 1; round <= 20; round++) {
  // Chrome only offers WebRTC host candidates from *all* interfaces (instead of
  // just the default route, 198.18.0.1 from the Clash TUN here) when camera/mic
  // permission is granted; without it the member can never see 192.168.50.200.
  // Nothing in this harness calls getUserMedia, so no capture happens.
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    permissions: ["camera"],
  });
  const admin = await context.newPage();
  admin.on("pageerror", (error) =>
    console.log("[admin] PAGEERROR", String(error).slice(0, 200)),
  );
  try {
    // v2: `/room` is the create route; diagnostics ride along in the query string.
    await admin.goto(`${BASE}/room${QUERY ? `?${QUERY}` : ""}`);
    await admin.waitForFunction(
      () => window.__crossfile?.snapshot?.().phase === "waiting",
      null,
      {
        timeout: 60_000,
      },
    );
    const link = await admin.evaluate(() => window.__crossfile.snapshot().link);
    // Query string carries diagnostics; report URLs must be URL-encoded inside it.
    publish(link.replace("#", `?${QUERY}#`));
    console.log(`round ${round}: ROOM LINK ${link}`);

    await admin.waitForFunction(
      () => (window.__crossfile?.snapshot?.().members ?? []).length >= 2,
      null,
      {
        timeout: GUEST_WAIT_MS,
      },
    );
    console.log(`round ${round}: member joined, approving`);
    await admin.getByTestId("approve").first().click();
    await admin.waitForFunction(
      () =>
        (window.__crossfile?.snapshot?.().members ?? []).some(
          (member) => !member.isAdmin && member.state === "joined",
        ),
      null,
      { timeout: 60_000 },
    );

    await admin.getByTestId("file-input").setInputFiles(fixture);
    console.log(`round ${round}: file offered, waiting for transfer`);
    const diag = setInterval(() => {
      void admin
        .evaluate(() => {
          const snapshot = window.__crossfile?.snapshot?.();
          return {
            phase: snapshot?.phase,
            transfer: snapshot?.transfers,
            members: snapshot?.members,
            notice: snapshot?.notice,
          };
        })
        .then((info) => console.log("ADMIN DIAG", JSON.stringify(info)))
        .catch(() => undefined);
    }, 15_000);
    try {
      await admin.waitForFunction(
        () => window.__crossfile?.snapshot?.().phase === "done",
        null,
        {
          timeout: 900_000,
        },
      );
    } finally {
      clearInterval(diag);
    }
    const result = await admin.evaluate(
      () => window.__crossfile.snapshot().result,
    );
    const members = await admin.evaluate(
      () => window.__crossfile.snapshot().members,
    );
    const peer = members.find((member) => !member.isAdmin);
    console.log(
      `ADMIN DONE sha256=${result?.sha256} bytes=${result?.bytes} path=${peer?.path}`,
    );
    console.log(`ADMIN HASH MATCHES EXPECTED: ${result?.sha256 === expected}`);
    await context.close();
    break;
  } catch (error) {
    console.log(
      `round ${round}: no member / failed (${String(error).slice(0, 120)}) — opening a new room`,
    );
    await context.close().catch(() => undefined);
    clearPublished();
  }
}

await browser.close();
