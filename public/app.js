const $ = id => document.getElementById(id);
let savedAi = false;
let canForgetAi = false;
let settingsBusy = true;
let questionBusy = true;
let canForgetQuestion = false;
let analysisController;
let healthTimer;
let dataBusy = true;
let dataMeta = {};
let dataSettingsFailed = false;

try {
  const config = await fetch("/api/config").then(r => r.json());
  $("ibkrBase").value = config.defaultIbkrBase;
  $("brokerMode").value = config.defaultBrokerMode || "gateway";
  showConnectionMode();
} catch { $("statusOutput").textContent = "The local advisor is unavailable. Start it and reload this page."; }
try {
  const response = await fetch("/api/settings/openai", { signal: AbortSignal.timeout(15_000) });
  const settings = await response.json();
  if (!response.ok) throw new Error(settings.error || "Saved AI settings are unavailable.");
  applyAiSettings(settings);
} catch (error) {
  $("aiSettingsOutput").textContent = error.message;
  canForgetAi = true;
  $("forgetAi").disabled = false;
} finally {
  settingsBusy = false;
  $("saveAi").disabled = false;
  $("useAi").disabled = false;
  $("analyze").disabled = questionBusy || dataBusy;
}

try {
  const response = await fetch("/api/settings/question", { signal: AbortSignal.timeout(15_000) });
  const settings = await response.json();
  if (!response.ok) throw new Error(settings.error || "The saved question is unavailable.");
  applyQuestionSettings(settings);
} catch (error) {
  $("questionSettingsOutput").textContent = error.message;
  canForgetQuestion = true;
} finally { questionFieldsLocked(false); }

const dataProviders = ["tradier", "alpha_vantage"];
function applyDataSettings(settings) {
  dataSettingsFailed = false;
  dataMeta = settings;
  for (const provider of dataProviders) {
    const meta = settings[provider];
    $(provider + "Key").value = "";
    $(provider + "Key").placeholder = meta?.saved ? "Saved; enter only to replace" : "Enter provider key or token";
    $(provider + "KeyState").textContent = meta?.saved ? "Saved on this computer" : "Not configured";
    $(provider + "Enabled").checked = meta?.saved ? meta.enabled : true;
    if (provider === "tradier") $("tradierMode").value = meta?.mode || "sandbox";
  }
}
function lockData(locked) {
  dataBusy = locked;
  for (const provider of dataProviders) {
    for (const suffix of ["Key", "Enabled", "Save"]) $(provider + suffix).disabled = locked;
    for (const suffix of ["Test", "Forget"]) $(provider + suffix).disabled = locked || !dataMeta[provider]?.saved;
  }
  $("tradierMode").disabled = locked;
  $("resetData").disabled = locked || !dataSettingsFailed && !dataProviders.some(p => dataMeta[p]?.saved);
  $("analyze").disabled = locked || settingsBusy || questionBusy || Boolean(analysisController);
}
try {
  const response = await fetch("/api/settings/data", { signal: AbortSignal.timeout(15000) });
  const settings = await response.json();
  if (!response.ok) throw new Error(settings.error || "Data-source settings are unavailable.");
  applyDataSettings(settings);
} catch (error) { dataSettingsFailed = true; for (const provider of dataProviders) $(provider + "Output").textContent = error.message; }
finally { lockData(false); }

$("resetData").addEventListener("click", async () => {
  if (dataBusy || analysisController || !window.confirm("Forget both data-source keys? Your OpenAI settings and saved question will stay unchanged.")) return;
  lockData(true);
  try {
    applyDataSettings(await post("/api/settings/data/reset", {}, AbortSignal.timeout(15000)));
    for (const p of dataProviders) $(p + "Output").textContent = "Data-source keys removed. OpenAI settings and saved question are unchanged.";
  } catch (error) { for (const p of dataProviders) $(p + "Output").textContent = error.message; }
  finally { lockData(false); }
});

async function changeData(provider, action) {
  if (dataBusy || analysisController) return;
  lockData(true);
  $(provider + "Output").textContent = action === "test" ? "Testing saved connection..." : "Updating saved settings...";
  try {
    const body = action === "save" ? { provider, key: $(provider + "Key").value.trim(), enabled: $(provider + "Enabled").checked,
      mode: provider === "tradier" ? $("tradierMode").value : "live" } : { provider };
    const data = await post("/api/settings/data" + (action === "save" ? "" : "/" + action), body, AbortSignal.timeout(25000));
    if (action === "test") {
      const names = { KEY_OR_ENTITLEMENT_REJECTED: "The saved key or its data permission was rejected. Check the token environment.",
        CONNECTED: "Connected successfully.", DISABLED: "This saved source is disabled.", KEY_REQUIRED: "Save a provider key first.",
        PROVIDER_RATE_LIMIT: "The provider request limit was reached.", PROVIDER_ACCESS_REQUIRED: "This data requires additional provider permission.",
        PROVIDER_UNAVAILABLE: "The provider could not be reached.", DAILY_BUDGET_REACHED: "Today's local request budget has been used." };
      $(provider + "Output").textContent = (names[data.status] || data.status.toLowerCase().replaceAll("_", " ")) +
        (data.quote_status && data.quote_status !== "AVAILABLE" ? " Latest quote: " + data.quote_status.toLowerCase().replaceAll("_", " ") + "." : "") +
        (data.last_quote_at ? " Quote timestamp: " + data.last_quote_at : "");
    } else {
      applyDataSettings(data);
      $(provider + "Output").textContent = action === "forget" ? "Saved key removed." : "Saved securely. Test the connection next.";
    }
  } catch (error) { $(provider + "Output").textContent = error.message; }
  finally { lockData(false); }
}
for (const provider of dataProviders) {
  for (const action of ["Save", "Test", "Forget"]) $(provider + action).addEventListener("click", () => changeData(provider, action.toLowerCase()));
  $(provider + "Key").addEventListener("input", () => { $(provider + "KeyState").textContent = "Changes not saved"; });
  $(provider + "Enabled").addEventListener("change", () => { $(provider + "Output").textContent = "Change not saved."; });
}
$("tradierMode").addEventListener("change", () => { $("tradierOutput").textContent = "Environment change not saved. The token must match this environment."; });

function applyQuestionSettings(settings) {
  canForgetQuestion = settings.saved;
  if (settings.saved) $("question").value = settings.question;
  $("questionState").textContent = settings.saved ? "Saved on this computer" : "Not saved";
}

function questionFieldsLocked(locked) {
  questionBusy = locked;
  for (const id of ["question", "saveQuestion"]) $(id).disabled = locked;
  $("forgetQuestion").disabled = locked || !canForgetQuestion;
  $("analyze").disabled = locked || settingsBusy || dataBusy;
}

async function updateQuestionSettings(forget) {
  if (questionBusy || analysisController) return;
  questionFieldsLocked(true);
  $("questionSettingsOutput").textContent = forget ? "Forgetting saved question..." : "Saving question...";
  try {
    const settings = await post(forget ? "/api/settings/question/forget" : "/api/settings/question", forget ? {} : { question: $("question").value }, AbortSignal.timeout(30_000));
    applyQuestionSettings(settings);
    $("questionSettingsOutput").textContent = forget ? "Saved question removed. The current text is not saved." : "Question saved on this computer.";
  } catch (error) { $("questionSettingsOutput").textContent = error.message; }
  finally { questionFieldsLocked(false); }
}

$("saveQuestion").addEventListener("click", () => updateQuestionSettings(false));
$("forgetQuestion").addEventListener("click", () => updateQuestionSettings(true));
$("question").addEventListener("input", () => {
  $("questionState").textContent = "Changes not saved";
  $("questionSettingsOutput").textContent = "";
});

function applyAiSettings(settings) {
  savedAi = settings.saved;
  canForgetAi = savedAi;
  $("model").value = settings.model;
  $("openaiKey").value = "";
  $("openaiKey").placeholder = savedAi ? "Saved; enter only to replace" : "sk-…";
  $("keyState").textContent = savedAi ? "Saved on this computer" : "Not saved";
  $("forgetAi").disabled = !savedAi;
  $("useAi").checked = savedAi;
}

function aiFieldsLocked(locked) {
  settingsBusy = locked;
  for (const id of ["saveAi", "openaiKey", "model", "useAi"]) $(id).disabled = locked;
  $("analyze").disabled = locked || questionBusy || dataBusy;
  $("forgetAi").disabled = locked || !canForgetAi;
}

async function updateAiSettings(forget) {
  if (settingsBusy || analysisController) return;
  aiFieldsLocked(true);
  $("aiSettingsOutput").textContent = forget ? "Forgetting saved settings…" : "Saving with Windows protection…";
  try {
    const body = forget ? {} : { openai_api_key: $("openaiKey").value.trim(), openai_model: $("model").value.trim() };
    const data = await post(forget ? "/api/settings/openai/forget" : "/api/settings/openai", body, AbortSignal.timeout(30_000));
    applyAiSettings(data);
    $("aiSettingsOutput").textContent = forget ? "Saved AI settings removed." : "API key and model saved on this computer.";
  } catch (error) { $("aiSettingsOutput").textContent = error.message; }
  finally { aiFieldsLocked(false); }
}

$("saveAi").addEventListener("click", () => updateAiSettings(false));
$("forgetAi").addEventListener("click", () => updateAiSettings(true));
$("openaiKey").addEventListener("input", () => {
  if ($("openaiKey").value.trim()) $("useAi").checked = true;
  $("keyState").textContent = $("openaiKey").value ? "New key not saved" : savedAi ? "Saved on this computer" : "Not saved";
});
$("model").addEventListener("input", () => { $("aiSettingsOutput").textContent = "Model change not saved."; });

function connectionPayload() {
  if ($("brokerMode").value === "tws") return {
    broker_mode: "tws", tws_port: Number($("twsPort").value), account_id: $("accountId").value.trim()
  };
  return {
    broker_mode: "gateway",
    ibkr_base_url: $("ibkrBase").value.trim(),
    ibkr_bearer_token: $("ibkrToken").value.trim(),
    account_id: $("accountId").value.trim(),
    keep_alive: $("keepAlive").checked
  };
}

async function post(url, body, signal = AbortSignal.timeout(125_000)) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || `Request failed: ${response.status}`), { code: data.code, loginUrl: data.login_url });
  return data;
}

$("status").addEventListener("click", async () => {
  $("status").disabled = true;
  $("gatewayLogin").hidden = true;
  $("statusOutput").textContent = "Checking…";
  try {
    const data = await post("/api/status", connectionPayload());
    $("statusOutput").textContent = data.auth_mode === "tws"
      ? `Connected through TWS. ${data.account_count} account(s) available. Advisor access is read-only.`
      : data.state === "portfolio_only"
      ? `Browser login succeeded. ${data.account_count} portfolio account(s) available. Live quotes are unavailable because the brokerage connection is not ready.${data.keep_alive ? " Portfolio keep-alive is active." : ""}`
      : `Connected. ${data.account_count} account(s) available.${data.keep_alive ? " Session keep-alive is active." : ""}`;
    if (data.keep_alive) pollHealth();
  } catch (error) {
    $("statusOutput").textContent = error.message;
    showLogin(error.loginUrl);
  } finally { $("status").disabled = false; }
});

$("analyze").addEventListener("click", async () => {
  if (analysisController || settingsBusy || questionBusy || dataBusy) return;
  analysisController = new AbortController();
  const timeout = setTimeout(() => analysisController?.abort(), 245_000);
  $("analyze").disabled = true;
  $("cancel").hidden = false;
  $("working").hidden = false;
  $("working").textContent = $("useAi").checked ? "Reading IBKR and requesting AI review…" : "Reading IBKR for local review…";
  aiFieldsLocked(true);
  questionFieldsLocked(true);
  lockData(true);
  $("resultCard").hidden = true;
  $("payload").textContent = "";
  $("verified").textContent = "";
  $("validation").textContent = "";
  try {
    const data = await post("/api/analyze", { ...connectionPayload(), scan_ideas: $("scanIdeas").checked, use_ai: $("useAi").checked, openai_api_key: $("useAi").checked ? $("openaiKey").value.trim() : "",
      openai_model: $("model").value.trim(), question: $("question").value.trim() }, analysisController.signal);
    $("advice").textContent = data.advice;
    $("payload").textContent = data.data_sent_to_openai ? JSON.stringify(data.data_sent_to_openai, null, 2) : "Nothing was sent to OpenAI.";
    $("verified").textContent = JSON.stringify(data.verified_data || {}, null, 2);
    $("validation").textContent = (data.validation || []).map(issue => `${issue.ref}: ${issue.message}`).join("\n");
    $("meta").textContent = `${data.option_position_count} option position(s) • ${data.state.replaceAll("_", " ")}${data.model ? " • " + data.model : ""}`;
    $("resultCard").hidden = false;
  } catch (error) {
    $("advice").textContent = error.name === "AbortError" ? "Analysis cancelled. No new review was displayed." : error.message;
    $("meta").textContent = error.name === "AbortError" ? "Cancelled" : "Error";
    showLogin(error.loginUrl);
    $("resultCard").hidden = false;
  } finally {
    clearTimeout(timeout);
    analysisController = null;
    $("analyze").disabled = false;
    $("cancel").hidden = true;
    $("working").hidden = true;
    aiFieldsLocked(false);
    questionFieldsLocked(false);
    lockData(false);
  }
});

$("cancel").addEventListener("click", () => analysisController?.abort());
for (const id of ["brokerMode", "twsPort", "ibkrBase", "ibkrToken", "accountId"]) $(id).addEventListener("change", async () => {
  showConnectionMode();
  analysisController?.abort();
  clearTimeout(healthTimer);
  $("statusOutput").textContent = "Connection settings changed. Connection not checked.";
  $("resultCard").hidden = true;
  $("gatewayLogin").hidden = true;
  try { await post("/api/disconnect", {}); }
  catch (error) { $("statusOutput").textContent = error.message; }
});
function showConnectionMode() {
  const tws = $("brokerMode").value === "tws";
  $("twsSettings").hidden = !tws;
  for (const id of ["gatewayBaseSettings", "gatewayTokenSettings", "gatewayKeepAlive"]) $(id).hidden = tws;
}
$("keepAlive").addEventListener("change", async () => {
  if ($("keepAlive").checked) { $("statusOutput").textContent = "Test the connection to enable keep-alive."; return; }
  clearTimeout(healthTimer);
  try { await post("/api/disconnect", {}); $("statusOutput").textContent = "Session keep-alive stopped."; }
  catch (error) { $("statusOutput").textContent = error.message; }
});
function showLogin(url) {
  if (!url) return;
  const login = new URL(url);
  if (login.protocol !== "https:" || !["localhost", "127.0.0.1", "[::1]"].includes(login.hostname)) return;
  $("gatewayLogin").href = login.href;
  $("gatewayLogin").hidden = false;
}
function pollHealth() {
  clearTimeout(healthTimer);
  healthTimer = setTimeout(async () => {
    try {
      const health = await fetch("/api/health", { signal: AbortSignal.timeout(5000) }).then(r => r.json());
      if (health.keep_alive) pollHealth();
      else $("statusOutput").textContent = health.last_keepalive_error ? "Gateway session ended. Test the connection for details." : "Session keep-alive is inactive.";
    } catch { $("statusOutput").textContent = "The local advisor is unavailable."; }
  }, 30_000);
}
