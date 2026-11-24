/**
 * The six digit join code (docs/02 §3.5): valid for 10 minutes, single use, memory only.
 *
 * `docs/02 §3.2` has no message that carries the code explicitly; §3.5 only says
 * "S 用短码映射到 roomId". The server therefore accepts a six digit value in `join.roomId`
 * and maps it to the room here before schema validation (see server.ts prepareShortCode).
 */
import { randomInt } from "node:crypto";

export const SHORTCODE_TTL_MS = 10 * 60_000;

export interface ShortCodeEntry {
  roomId: string;
  expiresAt: number;
}

export class ShortCodeStore {
  private readonly byCode = new Map<string, ShortCodeEntry>();
  private readonly byRoom = new Map<string, string>();
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  /**
   * Issue an unused code for the room, or return the still-valid code it already has.
   * `randomInt` avoids Math.random so codes are not predictable from other random output.
   */
  issue(roomId: string): string {
    const existing = this.byRoom.get(roomId);
    if (existing) {
      const entry = this.byCode.get(existing);
      if (entry && entry.expiresAt > this.now()) return existing;
      this.byCode.delete(existing);
      this.byRoom.delete(roomId);
    }
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const code = randomInt(0, 1_000_000)
        .toString()
        .padStart(6, "0");
      if (this.byCode.has(code)) continue;
      this.byCode.set(code, { roomId, expiresAt: this.now() + SHORTCODE_TTL_MS });
      this.byRoom.set(roomId, code);
      return code;
    }
    throw new Error("six digit code space exhausted");
  }

  /** Look the code up without using it (used by the pre-parse normalisation step). */
  resolve(code: string): string | null {
    const entry = this.byCode.get(code);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.forget(code, entry);
      return null;
    }
    return entry.roomId;
  }

  /** Single use: a successful resolution consumes the code. */
  consume(code: string): string | null {
    const entry = this.byCode.get(code);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.forget(code, entry);
      return null;
    }
    this.forget(code, entry);
    return entry.roomId;
  }

  revokeRoom(roomId: string): void {
    const code = this.byRoom.get(roomId);
    if (code !== undefined) this.byCode.delete(code);
    this.byRoom.delete(roomId);
  }

  sweep(): void {
    const at = this.now();
    for (const [code, entry] of this.byCode) {
      if (entry.expiresAt <= at) this.forget(code, entry);
    }
  }

  clear(): void {
    this.byCode.clear();
    this.byRoom.clear();
  }

  private forget(code: string, entry: ShortCodeEntry): void {
    this.byCode.delete(code);
    if (this.byRoom.get(entry.roomId) === code) this.byRoom.delete(entry.roomId);
  }
}
