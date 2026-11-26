import { expect, test } from "@playwright/test";
import WebSocket from "ws";

const SIGNALING_PORT = Number(process.env.E2E_SIGNALING_PORT ?? 8790);

/**
 * AC14 (ADR 0010 §版本门禁, D22): v1 clients are not silently tolerated. The
 * signaling server answers VERSION_MISMATCH with a refresh hint and closes; a page
 * that ends up on the wrong version shows the reload affordance.
 */
test("AC14: a v1 client is rejected with VERSION_MISMATCH and a refresh hint", async () => {
  const result = await new Promise<{
    code?: string;
    msg?: string;
    closed: boolean;
  }>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${SIGNALING_PORT}/v1/ws`);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("signaling answered neither an error nor a close"));
    }, 10_000);
    let answered: { code?: string; msg?: string } = {};
    ws.on("open", () => {
      ws.send(JSON.stringify({ v: 1, type: "hello" }));
    });
    ws.on("message", (data) => {
      const message = JSON.parse(String(data)) as {
        type: string;
        code?: string;
        msg?: string;
      };
      if (message.type === "error") {
        answered = { code: message.code, msg: message.msg };
      }
    });
    ws.on("close", () => {
      clearTimeout(timer);
      resolve({ ...answered, closed: true });
    });
    ws.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  expect(result.closed).toBe(true);
  expect(result.code).toBe("VERSION_MISMATCH");
  expect(result.msg ?? "").toContain("刷新");
});

test("AC14: a page on the old protocol shows the reload button", async ({
  browser,
}) => {
  const context = await browser.newContext();
  // Simulate a cached/old page: downgrade the version on the signalling hello.
  await context.addInitScript(() => {
    const proto = WebSocket.prototype;
    const original = proto.send;
    proto.send = function send(
      this: WebSocket,
      data: string | ArrayBufferLike | Blob | ArrayBufferView,
    ) {
      let payload: unknown = data;
      if (typeof data === "string" && data.includes('"type":"hello"')) {
        try {
          const message = JSON.parse(data) as Record<string, unknown>;
          message.v = 1;
          payload = JSON.stringify(message);
        } catch {
          // keep the original frame
        }
      }
      return (original as (this: WebSocket, data: unknown) => void).call(
        this,
        payload,
      );
    };
  });

  const page = await context.newPage();
  await page.goto("/room");
  await expect(page.getByTestId("version-reload")).toBeVisible({
    timeout: 30_000,
  });

  await context.close();
});
