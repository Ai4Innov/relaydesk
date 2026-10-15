(function () {
  "use strict";
  const status = document.getElementById("status");
  const pairState = document.getElementById("pair-state");
  const tabState = document.getElementById("tab-state");
  const tabReason = document.getElementById("tab-reason");
  const tabReasons = {
    readerCapacity: "Reader capacity reached. Close safely idle agent tabs; protected tabs require your review.",
    wakeCapacity: "Bootstrap capacity reached. Close safely idle agent tabs; protected tabs require your review.",
    viewCapacity: "Account-view capacity reached. Reuse an existing account tab or close unused agent views.",
    inspectionTimeout: "A browser tab did not respond in time. Keep the browser available and retry.",
    inspectionUnavailable: "A tab could not be inspected safely and was retained.",
    readerLoading: "The Gmail reader was still loading.",
    readerStatusUnavailable: "The Gmail reader could not confirm its page status.",
    protectedTab: "A tab was protected because it may contain your work.",
    documentMismatch: "The tab document changed; it was not reused.",
    allocationFailed: "A worker tab could not be prepared.",
    readUnavailable: "The full-email read was unavailable.",
  };
  const code = document.getElementById("code");
  const bind = (id, work) => {
    const element = document.getElementById(id);
    if (element) element.addEventListener("click", work);
    return element;
  };

  async function request(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response || !response.ok) throw new Error(response && response.error || "The extension did not respond. Reload the extension and retry.");
    return response.value;
  }

  async function refreshPairing() {
    const state = await request({ type: "state" });
    pairState.textContent = state.paired ? "Paired with the local Relay Desk app." : "Not paired. Open the desktop app to generate a code.";
    if (tabState) {
      try {
        const tabs = await request({ type: "tab-management" });
        tabState.textContent = `Agent tabs: ${tabs.mailOwned + tabs.viewOwned} / ${tabs.limit}. Mail workers: ${tabs.mailOwned} (idle: ${tabs.mailIdle}). Account views: ${tabs.viewOwned}.`;
        if (tabReason) {
          const info = tabs.debug;
          tabReason.textContent = info ? `Protected: ${info.protected}. Loading: ${info.loading}. In use: ${info.busy}. Unresponsive: ${info.statusUnavailable}.`
            + (tabReasons[info.lastReason] ? ` Last recorded issue: ${tabReasons[info.lastReason]}` : "") : "";
        }
      } catch (error) {
        tabState.textContent = error.message;
        if (tabReason) tabReason.textContent = "";
      }
    }
  }

  async function act(work) {
    for (const button of document.querySelectorAll("button")) button.disabled = true;
    try { await work(); }
    catch (error) { status.textContent = error.message; }
    finally {
      try { await refreshPairing(); } catch (error) { pairState.textContent = error.message; }
      for (const button of document.querySelectorAll("button")) button.disabled = false;
    }
  }

  document.getElementById("pair-form").addEventListener("submit", event => {
    event.preventDefault();
    act(async () => {
      await request({ type: "pair", code: code.value });
      code.value = "";
      status.textContent = "Browser profile paired. No account link is needed. Open Gmail or Calendar tabs are discovered in the background. If none are open, open an account when ready or choose Discover signed-in Google accounts.";
    });
  });
  const accountLinkForm = document.getElementById("account-link-form");
  if (accountLinkForm) accountLinkForm.addEventListener("submit", event => {
    event.preventDefault();
    act(async () => {
      status.textContent = "Opening the account in this browser profile. Waiting for its verified Google header...";
      const result = await request({ type: "add-account-link", url: document.getElementById("account-link").value });
      status.textContent = result.message;
    });
  });
  for (const action of ["connect", "capture"]) {
    bind(action, () => act(async () => {
      const result = await request({ type: "current-tab", action });
      status.textContent = result.status;
    }));
  }
  bind("discover-open-tabs", () => act(async () => {
    const result = await request({ type: "discover-open-tabs" });
    status.textContent = result.message || `Asked ${result.discovered || 0} open Google tabs to disclose account metadata.`;
  }));
  bind("open-whatsapp", () => act(async () => {
    const result = await request({ type: "open-whatsapp" });
    status.textContent = result.message;
  }));
  bind("discover-signed-in-accounts", () => act(async () => {
    let granted = false;
    try {
      granted = await chrome.permissions.request({
        permissions: ["scripting"],
        origins: ["https://ogs.google.com/*"]
      });
    } catch {
      throw new Error("Google account-menu access could not be requested. Reload the companion and retry from this popup.");
    }
    if (!granted) {
      throw new Error("Google account-menu access was not granted. No accounts were read. Allow the optional access and retry.");
    }
    status.textContent = "Opening Google's account menu in a loaded Gmail or Calendar tab...";
    const result = await request({ type: "discover-signed-in-accounts" });
    status.textContent = result.message;
  }));
  bind("forget", () => act(async () => {
    await request({ type: "forget" });
    status.textContent = "Local pairing removed. Capture is stopped. You can also revoke pairing in the desktop app.";
  }));
  bind("reload", () => chrome.runtime.reload());
  bind("fresh-account-views", () => act(async () => {
    const result = await request({ type: "fresh-account-views" });
    status.textContent = result.message;
  }));
  bind("cleanup-agent-tabs", () => act(async () => {
    const result = await request({ type: "cleanup-agent-tabs" });
    status.textContent = result.message;
  }));
  bind("refresh-tab-state", () => act(async () => {
    status.textContent = "Agent tab status refreshed.";
  }));
  act(async () => {
    status.textContent = "Pairing connects this browser profile, not a single account. Account discovery and capture are separate actions.";
  });
})();
