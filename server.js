const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL, URLSearchParams } = require("node:url");
const { spawn, spawnSync } = require("node:child_process");

function loadEnvironment() {
  const environmentPath = path.join(__dirname, ".env");
  if (!fs.existsSync(environmentPath)) return;
  for (const line of fs.readFileSync(environmentPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !match[1].startsWith("#") && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
}

loadEnvironment();

const port = Number(process.env.PORT || 4173);
const publicFiles = new Map([["/", "index.html"], ["/index.html", "index.html"], ["/app.js", "app.js"], ["/styles.css", "styles.css"]]);
const stravaProxy = process.env.STRAVA_PROXY || "http://proxy.p1at.s-group.cc:8080";
const credentialWrapperPath = path.join(__dirname, "strava-credentials.py");
const pythonCommand = process.env.PYTHON || "py";
const credentials = credentialRequest("get-client");
let token = credentialRequest("get-token");
let importJob = null;

function credentialRequest(operation, payload) {
  const result = spawnSync(pythonCommand, [credentialWrapperPath, operation], { input: payload ? JSON.stringify(payload) : undefined, encoding: "utf8", windowsHide: true });
  if (result.error) throw new Error(`Strava Credential Manager wrapper sa nedá spustiť: ${result.error.message}`);
  if (result.status !== 0) throw new Error(result.stderr.trim() || "Strava Credential Manager wrapper zlyhal.");
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

function windowsProxyRequest(url, options) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, "strava-request.ps1");
    const process = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", scriptPath, "-Proxy", stravaProxy], { stdio: ["pipe", "pipe", "pipe"] });
    let output = ""; let error = "";
    process.stdout.on("data", (chunk) => { output += chunk; });
    process.stderr.on("data", (chunk) => { error += chunk; });
    process.on("error", reject);
    process.on("close", (code) => {
      if (code !== 0) return reject(new Error(error.trim() || "Strava požiadavka cez firemnú proxy zlyhala."));
      try { resolve(JSON.parse(output)); } catch { reject(new Error("Strava vrátila neplatnú odpoveď.")); }
    });
    process.stdin.end(JSON.stringify({ url, method: options.method || "GET", headers: options.headers || {}, body: options.body ? String(options.body) : null, contentType: options.headers?.["Content-Type"] || null }));
  });
}

async function stravaRequest(url, options = {}) {
  if (process.platform === "win32") return windowsProxyRequest(url, options);
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`Strava vrátila ${response.status}: ${await response.text()}`);
  return response.json();
}

async function formRequest(parameters) {
  return stravaRequest("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(parameters)
  });
}

async function accessToken() {
  if (!token) throw new Error("Strava nie je pripojená. Najprv povoľ prístup.");
  if (token.expiresAt && token.expiresAt <= Math.floor(Date.now() / 1000) + 60) {
    if (!token.refreshToken) throw new Error("Strava token vypršal. Pripoj Stravu znovu.");
    const refreshed = await formRequest({ client_id: credentials.clientId, client_secret: credentials.clientSecret, grant_type: "refresh_token", refresh_token: token.refreshToken });
    token = { accessToken: refreshed.access_token, refreshToken: refreshed.refresh_token, expiresAt: refreshed.expires_at };
    credentialRequest("set-token", token);
  }
  return token.accessToken;
}

async function allActivities(accessTokenValue) {
  const activities = [];
  for (let page = 1; page <= 20; page += 1) {
    const response = await stravaRequest(`https://www.strava.com/api/v3/athlete/activities?per_page=200&page=${page}`, { headers: { Authorization: `Bearer ${accessTokenValue}` } });
    const activityList = Array.isArray(response?.value) ? response.value : response;
    const result = Array.isArray(activityList) ? activityList : activityList ? [activityList] : [];
    activities.push(...result);
    if (result.length < 200) break;
  }
  return activities;
}

async function importActivities(job) {
  const accessTokenValue = await accessToken();
  const activities = await allActivities(accessTokenValue);
  const imported = [];
  const skipped = [];
  job.total = activities.length;
  for (const activity of activities) {
    try {
      if (!activity?.id) throw new Error(`Strava aktivita nemá ID (prijaté polia: ${Object.keys(activity || {}).join(", ") || "žiadne"}).`);
      const streams = await stravaRequest(`https://www.strava.com/api/v3/activities/${activity.id}/streams?keys=latlng,time,altitude,heartrate,moving&key_by_type=true`, { headers: { Authorization: `Bearer ${accessTokenValue}` } });
      const latlng = streams.latlng?.data || [];
      if (latlng.length < 2) { skipped.push({ id: activity.id, title: activity.name, reason: "bez GPS bodov" }); job.skipped += 1; job.processed += 1; continue; }
      imported.push({
        stravaActivityId: activity.id,
        title: activity.name || `Strava aktivita ${activity.id}`,
        fileName: `Strava - ${activity.name || activity.id}`,
        points: latlng.map(([lat, lon], index) => ({ lat, lon, time: Number.isFinite(streams.time?.data?.[index]) ? new Date((activity.start_date_local ? Date.parse(activity.start_date_local) : Date.parse(activity.start_date)) + streams.time.data[index] * 1000).getTime() : NaN, heartRate: Number(streams.heartrate?.data?.[index]) })),
        distance: Number(activity.distance || 0) / 1000,
        activityDate: activity.start_date || null,
        movingSeconds: Number(activity.moving_time) || null,
        totalSeconds: Number(activity.elapsed_time) || null,
        movingSpeedKmh: Number(activity.average_speed) ? Number(activity.average_speed) * 3.6 : null,
        totalSpeedKmh: Number(activity.elapsed_time) ? Number(activity.distance) / Number(activity.elapsed_time) * 3.6 : null,
        averageHeartRate: Number(activity.average_heartrate) || null,
        maximumHeartRate: Number(activity.max_heartrate) || null
      });
      job.imported += 1;
    } catch (error) { skipped.push({ id: activity.id, title: activity.name, reason: error.message }); job.skipped += 1; }
    job.processed += 1;
  }
  return { activities: imported, skipped, total: activities.length };
}

function importJobStatus() {
  if (!importJob) return { status: "idle", total: 0, processed: 0, imported: 0, skipped: 0 };
  return { status: importJob.status, total: importJob.total, processed: importJob.processed, imported: importJob.imported, skipped: importJob.skipped, error: importJob.error || null };
}

function startImportJob() {
  if (importJob?.status === "running") return importJobStatus();
  importJob = { status: "running", total: 0, processed: 0, imported: 0, skipped: 0, result: null, error: null };
  importActivities(importJob).then((result) => { importJob.result = result; importJob.status = "complete"; }).catch((error) => {
    if (/\b401\b|unauthorized/i.test(error.message)) { token = null; credentialRequest("clear-token"); }
    importJob.error = error.message; importJob.status = "error";
  });
  return importJobStatus();
}

http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  try {
    if (requestUrl.pathname === "/api/strava/status") return sendJson(response, 200, { connected: Boolean(token), configured: true });
    if (requestUrl.pathname === "/api/strava/authorize") {
      const callbackUrl = `http://${request.headers.host}/api/strava/callback`;
      const authorizationUrl = new URL("https://www.strava.com/oauth/authorize");
      authorizationUrl.search = new URLSearchParams({ client_id: credentials.clientId, redirect_uri: callbackUrl, response_type: "code", approval_prompt: "auto", scope: "read,activity:read_all" }).toString();
      response.writeHead(302, { Location: authorizationUrl }); return response.end();
    }
    if (requestUrl.pathname === "/api/strava/callback") {
      if (!requestUrl.searchParams.get("code")) return sendJson(response, 400, { error: "Strava OAuth neposlala autorizačný kód." });
      const callbackUrl = `http://${request.headers.host}/api/strava/callback`;
      const exchanged = await formRequest({ client_id: credentials.clientId, client_secret: credentials.clientSecret, code: requestUrl.searchParams.get("code"), grant_type: "authorization_code", redirect_uri: callbackUrl });
      token = { accessToken: exchanged.access_token, refreshToken: exchanged.refresh_token, expiresAt: exchanged.expires_at };
      credentialRequest("set-token", token);
      response.writeHead(302, { Location: "/?strava=connected" }); return response.end();
    }
    if (requestUrl.pathname === "/api/strava/import" && request.method === "POST") return sendJson(response, 202, startImportJob());
    if (requestUrl.pathname === "/api/strava/import" && request.method === "GET") return sendJson(response, 200, importJobStatus());
    if (requestUrl.pathname === "/api/strava/import/data" && request.method === "GET") {
      if (importJob?.status !== "complete") return sendJson(response, 409, { error: "Strava import ešte nie je dokončený." });
      return sendJson(response, 200, importJob.result);
    }
    if (request.method === "GET" && publicFiles.has(requestUrl.pathname)) {
      const file = publicFiles.get(requestUrl.pathname);
      const contentType = file.endsWith(".css") ? "text/css; charset=utf-8" : file.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8";
      response.writeHead(200, { "Content-Type": contentType }); return fs.createReadStream(path.join(__dirname, file)).pipe(response);
    }
    sendJson(response, 404, { error: "Nenájdené." });
  } catch (error) {
    const isUnauthorized = /\b401\b|unauthorized/i.test(error.message);
    if (isUnauthorized) { token = null; credentialRequest("clear-token"); }
    sendJson(response, isUnauthorized ? 401 : 502, { error: error.message });
  }
}).listen(port, () => console.log(`Trasy backend beží na http://localhost:${port}`));
