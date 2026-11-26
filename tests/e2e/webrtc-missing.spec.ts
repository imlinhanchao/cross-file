import { expect, test } from "@playwright/test";

test("preflight: a webview without WebRTC shows an honest blocking message", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(() => {
    // Simulate distro WebKitGTK (Tauri on Linux): RTCPeerConnection is absent.
    delete (window as unknown as Record<string, unknown>).RTCPeerConnection;
    delete (window as unknown as Record<string, unknown>)
      .webkitRTCPeerConnection;
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "当前环境不支持 WebRTC" }),
  ).toBeVisible();
  await expect(page.getByText("请改用 Chrome / Edge / Safari")).toBeVisible();
  // No room is created and no failed handshake is attempted.
  await expect(page.getByTestId("create-room")).toHaveCount(0);
  await context.close();
});
