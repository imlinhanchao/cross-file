// Server-settings page logic for the Tauri shells (desktop + mobile).
//
// The page is served by the shell through its `crossfile-settings://` protocol
// and talks to Rust with the same custom commands on both shells:
//   get_server_settings / save_server_settings / reset_server_settings /
//   normalize_server_origin / close_server_settings
// URL normalisation/validation lives in Rust (server-config module), so this
// file only renders state, checks reachability and reports Chinese messages.
(function () {
  "use strict";

  const invoke = (command, args) => {
    const api = window.__TAURI__ && window.__TAURI__.core;
    if (!api || typeof api.invoke !== "function") {
      return Promise.reject(new Error("壳内 IPC 不可用"));
    }
    return api.invoke(command, args);
  };

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
  };

  let busy = false;
  let prefilled = false;

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
        ? "当前服务器由环境变量指定（CROSSFILE_SIGNALING_URL），应用内保存不会覆盖它。"
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
    try {
      const settings = await invoke("get_server_settings");
      if (settings) render(settings);
    } catch (error) {
      setStatus(`无法读取服务器设置：${messageOf(error)}`, "error");
    }
  }

  function messageOf(error) {
    if (!error) return "未知错误";
    return typeof error === "string" ? error : error.message || String(error);
  }

  function minimalClientCaps() {
    const ua = String(navigator.userAgent || "");
    const platform = /Android/i.test(ua)
      ? "android"
      : /iPhone|iPad|iPod/i.test(ua)
        ? "ios"
        : /Mac OS X/i.test(ua)
          ? "mac"
          : /Windows/i.test(ua)
            ? "win"
            : "linux";
    return {
      platform,
      uaFamily: "unknown",
      nativeShell: true,
      secureContext: window.isSecureContext === true,
      fsAccess: true,
      sw: false,
      swDownload: false,
      saveStrategies: ["native"],
      screen:
        window.innerWidth > 0 && window.innerWidth < 600 ? "phone" : "desktop",
    };
  }

  /** Open `<origin>/v1/ws`, send a minimal hello, report reachability, close. */
  function testSignaling(signalingUrl) {
    return new Promise((resolve) => {
      const started = Date.now();
      let settled = false;
      let socket = null;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          socket && socket.close();
        } catch {
          // already closed
        }
        resolve(result);
      };
      const timer = setTimeout(
        () => finish({ ok: false, message: "连接超时（5 秒内没有响应）" }),
        5000,
      );
      try {
        socket = new WebSocket(signalingUrl);
      } catch (error) {
        finish({ ok: false, message: `无法发起连接：${messageOf(error)}` });
        return;
      }
      socket.addEventListener("open", () => {
        try {
          socket.send(
            JSON.stringify({
              v: 2,
              type: "hello",
              clientCaps: minimalClientCaps(),
            }),
          );
        } catch {
          // The reachability handshake already succeeded.
        }
        finish({
          ok: true,
          message: "连接成功",
          latencyMs: Date.now() - started,
        });
      });
      socket.addEventListener("error", () =>
        finish({
          ok: false,
          message: "无法连接：请检查地址、网络或服务器是否在运行",
        }),
      );
      socket.addEventListener("close", () =>
        finish({ ok: false, message: "连接被服务器关闭" }),
      );
    });
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy) return;
    setError("");
    setStatus("正在保存…");
    setBusy(true);
    try {
      const result = await invoke("save_server_settings", {
        origin: input.value,
      });
      const message = result && result.message ? result.message : "已保存";
      setStatus(message, "success");
      if (result && result.settings) render(result.settings);
    } catch (error) {
      setError(messageOf(error));
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
      const preview = await invoke("normalize_server_origin", {
        origin: input.value,
      });
      const result = await testSignaling(preview.signalingUrl);
      if (!result.ok) {
        setStatus("");
        setError(result.message);
        return;
      }
      const latency =
        typeof result.latencyMs === "number"
          ? `（${result.latencyMs} 毫秒）`
          : "";
      setStatus(
        `连接成功：${preview.signalingUrl} ${latency}`.trim(),
        "success",
      );
    } catch (error) {
      setError(messageOf(error));
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
      const result = await invoke("reset_server_settings");
      input.value = result.settings.origin;
      setStatus(result.message || "已恢复官方实例", "success");
      render(result.settings);
    } catch (error) {
      setError(messageOf(error));
      setStatus("");
    } finally {
      setBusy(false);
    }
  });

  cancelButton.addEventListener("click", async () => {
    if (busy) return;
    try {
      await invoke("close_server_settings");
    } catch (error) {
      setStatus(`无法关闭设置页：${messageOf(error)}`, "error");
    }
  });

  // Escape = cancel/exit, matching the dialog convention.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || busy) return;
    event.preventDefault();
    cancelButton.click();
  });

  void refresh();
})();
