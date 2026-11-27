// Server-settings page logic for the Electron shell.
//
// The page is intentionally dependency-free: it talks to the main process
// through the narrow `window.crossfileSettings` bridge exposed by preload.cjs.
// URL normalisation/validation lives in the main process (server-config.cjs), so
// this file only renders state and reports the returned Chinese messages.
(function () {
  "use strict";

  const bridge = window.crossfileSettings;
  const $ = (id) => document.getElementById(id);

  const input = $("server-origin");
  const form = $("server-form");
  const saveButton = $("save");
  const testButton = $("test");
  const resetButton = $("reset");
  const cancelButton = $("cancel");
  const errorLine = $("server-error");
  const statusLine = $("status");
  const banners = {
    firstRun: $("banner-first-run"),
    env: $("banner-env"),
    load: $("banner-load"),
  };

  let busy = false;
  let prefilled = false;
  let currentSettings = null;

  function setBusy(value) {
    busy = value;
    for (const button of [saveButton, testButton, resetButton, cancelButton]) {
      button.disabled = value;
    }
  }

  function setError(message) {
    if (message) {
      errorLine.textContent = message;
      errorLine.hidden = false;
      input.setAttribute("aria-invalid", "true");
      input.focus();
    } else {
      errorLine.textContent = "";
      errorLine.hidden = true;
      input.removeAttribute("aria-invalid");
    }
  }

  function setStatus(message, kind) {
    statusLine.textContent = message || "";
    if (kind) statusLine.dataset.kind = kind;
    else delete statusLine.dataset.kind;
  }

  function showBanner(element, message) {
    if (message) {
      element.textContent = message;
      element.hidden = false;
    } else {
      element.textContent = "";
      element.hidden = true;
    }
  }

  function render(settings) {
    currentSettings = settings;
    $("current-origin").textContent = settings.origin;
    const labels = {
      default: "官方实例（默认）",
      saved: settings.isOfficial
        ? "官方实例（已保存）"
        : "自定义服务器（已保存）",
      env: "环境变量指定",
    };
    $("current-meta").textContent = labels[settings.source] || "自定义服务器";
    $("current-signal").textContent = `信令地址：${settings.signalingUrl}`;

    showBanner(
      banners.firstRun,
      settings.firstRun
        ? "首次使用：请确认服务器地址（已填好官方实例，可直接保存）。"
        : "",
    );
    showBanner(
      banners.env,
      settings.envOverride
        ? "当前服务器由环境变量指定（CROSSFILE_URL / CROSSFILE_SIGNALING_URL），应用内保存不会覆盖它。"
        : "",
    );
    const loadError = settings.lastLoadError;
    showBanner(
      banners.load,
      loadError
        ? `无法加载已保存的服务器 ${loadError.origin}：${loadError.message}。请检查地址或网络，也可以恢复官方实例。`
        : "",
    );

    cancelButton.textContent = settings.firstRun ? "退出 CrossFile" : "取消";
    if (!prefilled) {
      prefilled = true;
      input.value = settings.origin;
      input.focus();
      input.select();
    }
  }

  async function refresh() {
    if (!bridge) {
      setStatus("设置页未运行在桌面壳中，无法读取服务器设置。", "error");
      return;
    }
    try {
      const result = await bridge.get();
      if (!result || !result.ok) {
        setStatus((result && result.error) || "无法读取服务器设置。", "error");
        return;
      }
      render(result.settings);
    } catch (error) {
      setStatus(`无法读取服务器设置：${error.message}`, "error");
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    setError("");
    setStatus("正在保存…");
    setBusy(true);
    try {
      const result = await bridge.save(input.value);
      if (!result || !result.ok) {
        setError((result && result.error) || "保存失败，请检查服务器地址。");
        setStatus("");
        return;
      }
      setStatus(result.message || "已保存", "success");
      if (result.settings) render(result.settings);
    } catch (error) {
      setError(`保存失败：${error.message}`);
      setStatus("");
    } finally {
      setBusy(false);
    }
  });

  testButton.addEventListener("click", async () => {
    if (busy) return;
    setError("");
    setStatus("正在测试连接…");
    setBusy(true);
    try {
      const result = await bridge.test(input.value);
      if (!result || !result.ok) {
        setError(
          (result && result.error) || "无法测试连接，请检查服务器地址。",
        );
        setStatus("");
        return;
      }
      const latency =
        typeof result.latencyMs === "number"
          ? `（${result.latencyMs} 毫秒）`
          : "";
      setStatus(
        `连接成功：${result.signalingUrl} ${latency}`.trim(),
        "success",
      );
    } catch (error) {
      setError(`测试连接失败：${error.message}`);
      setStatus("");
    } finally {
      setBusy(false);
    }
  });

  resetButton.addEventListener("click", async () => {
    if (busy) return;
    setError("");
    setStatus("正在恢复官方实例…");
    setBusy(true);
    try {
      const result = await bridge.reset();
      if (!result || !result.ok) {
        setError((result && result.error) || "恢复官方实例失败。");
        setStatus("");
        return;
      }
      input.value = result.settings.origin;
      setStatus(result.message || "已恢复官方实例", "success");
      render(result.settings);
    } catch (error) {
      setError(`恢复官方实例失败：${error.message}`);
      setStatus("");
    } finally {
      setBusy(false);
    }
  });

  cancelButton.addEventListener("click", async () => {
    if (busy) return;
    try {
      const result = await bridge.cancel();
      if (result && result.stayed) {
        setStatus(result.message || "当前服务器仍无法访问。", "error");
      }
    } catch (error) {
      setStatus(`无法关闭设置页：${error.message}`, "error");
    }
  });

  // Escape = cancel/exit, matching the dialog convention. Keep it usable while
  // the input is focused (the input is the first focus target).
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || busy) return;
    event.preventDefault();
    cancelButton.click();
  });

  void refresh();
})();
