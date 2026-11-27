/**
 * Shared helpers for the v2 e2e suite (ADR 0010: one room, admin + members, any
 * direction between the admin and a member in phase 1).
 *
 * Design rules:
 * - select by `data-testid` only; UI copy is still being wired, so never match
 *   Chinese text here (the two exceptions are documented at their call site);
 * - read state through `window.__crossfile.snapshot()`, never by scraping the DOM;
 * - a spec that needs a fixture larger than 50 MB must write it to disk
 *   (`fixtureFile`), because Playwright caps `setInputFiles({buffer})` at 50 MB.
 */
import { expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export interface MemberSnapshot {
  id: string;
  name: string;
  isAdmin: boolean;
  state: string;
  path?: string;
  caps: {
    platform?: string;
    uaFamily?: string;
    screen?: string;
    storageQuotaMB?: number;
    fsAccess?: boolean;
  };
  progress?: { sentBytes: number; totalBytes: number };
}

export interface FileSnapshot {
  id: number;
  name: string;
  size: number;
  mime?: string;
}

export interface TransferSnapshot {
  transferId: string;
  peerId: string;
  direction: "out" | "in";
  files: FileSnapshot[];
  sentBytes: number;
  totalBytes: number;
  path?: string;
  queued?: boolean;
}

export interface IncomingSnapshot {
  transferId: string;
  peerId: string;
  peerName: string;
  files: FileSnapshot[];
  totalBytes: number;
  risk?: {
    level: string;
    message: string;
    softLimitMB: number;
    hardLimitMB?: number;
  };
}

export interface Snapshot {
  phase: string;
  role: "admin" | "member";
  selfId?: string;
  selfName?: string;
  roomId?: string;
  code?: string;
  link?: string;
  members: MemberSnapshot[];
  files: FileSnapshot[];
  assignments: Record<string, string[]>;
  transfers: Record<string, TransferSnapshot>;
  queue: Array<{ peerId: string; files: FileSnapshot[]; totalBytes: number }>;
  incoming?: IncomingSnapshot;
  /** v1-compatibility view of the most relevant active transfer. */
  transfer?: TransferSnapshot;
  result?: { ok: boolean; sha256?: string; bytes?: number; fileName?: string };
  risk?: { level: string; message: string; softLimitMB: number };
  error?: string;
  errorCode?: string;
  notice?: string;
  roomClosed?: boolean;
  versionOutdated?: boolean;
  /** reconnect went stale (old admin after a hand-over, expired rejoin token) */
  rejoinLost?: boolean;
  /** admin hand-over notice text shown on the page */
  handoverNotice?: string;
  sas?: string[];
  sasPending?: boolean;
  sasConfirmedByMe?: boolean;
  hasKey?: boolean;
  codeMode?: boolean;
  /** v1-compatibility view of every other member. */
  guests: Array<{
    id: string;
    name?: string;
    status: string;
    path?: string;
    caps: MemberSnapshot["caps"];
  }>;
}

export function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const hook = (
      window as unknown as { __crossfile?: { snapshot?: () => Snapshot } }
    ).__crossfile;
    if (!hook?.snapshot) throw new Error("__crossfile.snapshot hook missing");
    return hook.snapshot();
  });
}

/** Every member except this page's own device. */
export function others(view: Snapshot): MemberSnapshot[] {
  return view.members.filter((member) => member.id !== view.selfId);
}

/** Members whose pair is usable (joined, transferring or done). */
export function joined(view: Snapshot): MemberSnapshot[] {
  return others(view).filter((member) =>
    ["joined", "transferring", "done"].includes(member.state),
  );
}

export function memberById(
  view: Snapshot,
  id: string,
): MemberSnapshot | undefined {
  return view.members.find((member) => member.id === id);
}

export function transferOf(
  view: Snapshot,
  direction: "out" | "in",
): TransferSnapshot | undefined {
  return Object.values(view.transfers).find(
    (transfer) => transfer.direction === direction,
  );
}

export const PATH_LABELS = ["lan", "direct", "relay"] as const;

/** Poll the snapshot until `predicate` holds; fails with the label on timeout. */
export async function waitForSnapshot(
  page: Page,
  predicate: (view: Snapshot) => boolean,
  timeout = 60_000,
  label = "snapshot condition",
): Promise<void> {
  await expect
    .poll(async () => predicate(await snapshot(page)), {
      timeout,
      message: label,
    })
    .toBe(true);
}

export async function waitPhase(
  page: Page,
  phase: string,
  timeout = 120_000,
): Promise<void> {
  await waitForSnapshot(
    page,
    (view) => view.phase === phase,
    timeout,
    `phase=${phase}`,
  );
}

/**
 * Create a room from the admin side. Dev query parameters (`relay`,
 * `sasTimeoutMs`, ...) ride along; `/room` is the create route (docs/02 v2).
 */
export async function createRoom(
  page: Page,
  query?: string,
): Promise<{ link: string; code: string; roomId: string; selfId: string }> {
  await page.goto(`/room${query ? `?${query}` : ""}`);
  await waitPhase(page, "waiting", 60_000);
  const view = await snapshot(page);
  expect(view.role, "creator is the admin").toBe("admin");
  expect(view.link, "room link").toBeTruthy();
  expect(view.code, "6-digit code").toMatch(/^[0-9]{6}$/);
  expect(view.link, "link carries the room key in the fragment").toContain("#");
  return {
    link: view.link as string,
    code: view.code as string,
    roomId: view.roomId ?? "",
    selfId: view.selfId ?? "",
  };
}

/** Add dev query parameters to an invite link without breaking its fragment. */
export function withQuery(link: string, query?: string): string {
  if (!query) return link;
  return link.includes("?")
    ? link.replace("#", `&${query}#`)
    : link.replace("#", `?${query}#`);
}

export async function joinByLink(
  page: Page,
  link: string,
  query?: string,
): Promise<void> {
  await page.goto(withQuery(link, query));
}

/** The 6-digit-code path: `/code` -> `/j/<code>` (QR-path key absent, SAS required). */
export async function joinByCode(
  page: Page,
  code: string,
  query?: string,
): Promise<void> {
  await page.goto(`/code${query ? `?${query}` : ""}`);
  await page.getByTestId("code-input").fill(code);
  await page.getByTestId("code-submit").click();
}

/** Click the approve button of the (single) pending join request. */
export async function approve(page: Page): Promise<void> {
  await page.getByTestId("approve").first().click({ timeout: 60_000 });
}

export async function waitOthersJoined(
  page: Page,
  count: number,
  timeout = 60_000,
): Promise<void> {
  await waitForSnapshot(
    page,
    (view) => joined(view).length >= count,
    timeout,
    `${count} member(s) joined`,
  );
}

/** Wait for a pending join request and return its member id. */
export async function waitPending(
  page: Page,
  timeout = 30_000,
): Promise<string> {
  await waitForSnapshot(
    page,
    (view) => others(view).some((member) => member.state === "pending"),
    timeout,
    "pending join request",
  );
  const pending = others(await snapshot(page)).find(
    (member) => member.state === "pending",
  );
  return pending?.id ?? "";
}

/** Pick files in the room page (path or Playwright file payload). */
export async function pickFiles(
  page: Page,
  file: string | { name: string; mimeType: string; buffer: Buffer },
): Promise<void> {
  await page.getByTestId("file-input").setInputFiles(file);
}

/** Press the primary "start sending" button (enables the file × member matrix). */
export async function startSend(page: Page): Promise<void> {
  await page.getByTestId("start-send").click();
}

/** Write a random fixture to `.cache/fixtures` and return its path. */
export function fixtureFile(bytes: Buffer, name: string): string {
  const dir = resolve(".cache/fixtures");
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, name);
  writeFileSync(path, bytes); // random bytes differ per run: always rewrite
  return path;
}

export async function waitIncoming(
  page: Page,
  timeout = 60_000,
): Promise<IncomingSnapshot> {
  await waitForSnapshot(
    page,
    (view) => Boolean(view.incoming),
    timeout,
    "incoming manifest",
  );
  return (await snapshot(page)).incoming as IncomingSnapshot;
}

/** Accept the incoming manifest (a risk-warn manifest asks for a second confirmation). */
export async function acceptIncoming(
  page: Page,
  options: { riskConfirm?: boolean; timeout?: number } = {},
): Promise<void> {
  await page
    .getByTestId("accept")
    .click({ timeout: options.timeout ?? 60_000 });
  if (options.riskConfirm) {
    await page.getByTestId("dialog-confirm").click({ timeout: 30_000 });
  }
}

/** Collect uncaught errors and console errors for a set of pages. */
export function trackErrors(pages: Array<[string, Page]>): string[] {
  const errors: string[] = [];
  for (const [name, page] of pages) {
    page.on("pageerror", (error) => errors.push(`${name}: ${String(error)}`));
    page.on("console", (message) => {
      if (message.type() === "error")
        errors.push(`${name} console: ${message.text()}`);
    });
  }
  return errors;
}

/**
 * Wait until every page is `done` and reports the expected whole-file digest.
 * Works for a single transfer; callers running several rounds must first wait
 * for the next round to start, so a stale `done` cannot satisfy the assertion.
 */
export async function expectHashes(
  pages: Page[],
  expected: string,
  timeout = 180_000,
): Promise<void> {
  for (const page of pages) {
    await waitPhase(page, "done", timeout);
    await waitForSnapshot(
      page,
      (view) => view.result?.sha256 === expected,
      timeout,
      `sha256 ${expected.slice(0, 12)}`,
    );
  }
}
