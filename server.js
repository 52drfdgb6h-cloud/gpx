const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");
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
const databaseWrapperPath = path.join(__dirname, "postgres-routes.py");
const pythonCommand = process.env.PYTHON || "py";
const credentials = credentialRequest("get-client");
let token = credentialRequest("get-token");
databaseRequest("init");
databaseRequest("repair-text");
let importJob = null;
let routeImportJob = null;

function credentialRequest(operation, payload) {
  const result = spawnSync(pythonCommand, [credentialWrapperPath, operation], { input: payload ? JSON.stringify(payload) : undefined, encoding: "utf8", windowsHide: true });
  if (result.error) throw new Error(`Strava Credential Manager wrapper sa nedá spustiť: ${result.error.message}`);
  if (result.status !== 0) throw new Error(result.stderr.trim() || "Strava Credential Manager wrapper zlyhal.");
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

function databaseRequest(operation, payload, routeId) {
  const processArgs = [databaseWrapperPath, operation];
  if (routeId !== undefined) processArgs.push(String(routeId));
  const result = spawnSync(pythonCommand, processArgs, { input: payload ? JSON.stringify(payload) : undefined, encoding: "utf8", windowsHide: true });
  if (result.error) throw new Error(`PostgreSQL wrapper sa nedá spustiť: ${result.error.message}`);
  if (result.status !== 0) throw new Error(result.stderr.trim() || "PostgreSQL wrapper zlyhal.");
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

function databaseRequestAsync(operation, payload, routeId) {
  return new Promise((resolve, reject) => {
    const processArgs = [databaseWrapperPath, operation];
    if (routeId !== undefined) processArgs.push(String(routeId));
    const process = spawn(pythonCommand, processArgs, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let output = ""; let error = "";
    process.stdout.on("data", (chunk) => { output += chunk; });
    process.stderr.on("data", (chunk) => { error += chunk; });
    process.on("error", (spawnError) => reject(new Error(`PostgreSQL wrapper sa nedá spustiť: ${spawnError.message}`)));
    process.on("close", (code) => {
      if (code !== 0) return reject(new Error(error.trim() || "PostgreSQL wrapper zlyhal."));
      try { resolve(output.trim() ? JSON.parse(output) : null); } catch { reject(new Error("PostgreSQL wrapper vrátil neplatnú odpoveď.")); }
    });
    process.stdin.end(payload ? JSON.stringify(payload) : undefined);
  });
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => { try { resolve(JSON.parse(body)); } catch { reject(new Error("Neplatné JSON dáta.")); } });
    request.on("error", reject);
  });
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

function decodePolyline(polyline) {
  const points = [];
  let index = 0; let latitude = 0; let longitude = 0;
  while (index < polyline.length) {
    let result = 0; let shift = 0; let byte;
    do { byte = polyline.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20 && index <= polyline.length);
    latitude += result & 1 ? ~(result >> 1) : result >> 1;
    result = 0; shift = 0;
    do { byte = polyline.charCodeAt(index++) - 63; result |= (byte & 0x1f) << shift; shift += 5; } while (byte >= 0x20 && index <= polyline.length);
    longitude += result & 1 ? ~(result >> 1) : result >> 1;
    points.push({ lat: latitude / 1e5, lon: longitude / 1e5, time: NaN, heartRate: NaN });
  }
  return points;
}

async function allAthleteRoutes(accessTokenValue) {
  const athlete = await stravaRequest("https://www.strava.com/api/v3/athlete", { headers: { Authorization: `Bearer ${accessTokenValue}` } });
  if (!athlete?.id) throw new Error("Strava neposkytla ID prihláseného športovca.");
  const routes = [];
  for (let page = 1; page <= 20; page += 1) {
    const response = await stravaRequest(`https://www.strava.com/api/v3/athletes/${athlete.id}/routes?per_page=200&page=${page}`, { headers: { Authorization: `Bearer ${accessTokenValue}` } });
    const routeList = Array.isArray(response?.value) ? response.value : response;
    const result = Array.isArray(routeList) ? routeList : routeList ? [routeList] : [];
    routes.push(...result);
    if (result.length < 200) break;
  }
  return routes;
}

async function inspectAthleteRoute() {
  const accessTokenValue = await accessToken();
  let routes;
  try {
    routes = await allAthleteRoutes(accessTokenValue);
  } catch (error) {
    return { stage: "list", error: error.message };
  }
  const [summary] = routes;
  if (!summary?.id) throw new Error("Strava neposkytla žiadnu route s platným ID.");
  let detailResponse;
  try {
    detailResponse = await stravaRequest(`https://www.strava.com/api/v3/routes/${summary.id}`, { headers: { Authorization: `Bearer ${accessTokenValue}` } });
  } catch (error) {
    return { stage: "detail", routeCount: routes.length, summaryFields: Object.keys(summary), error: error.message };
  }
  const wrappedValue = detailResponse?.value;
  const detail = Array.isArray(wrappedValue) ? wrappedValue[0] : wrappedValue || detailResponse;
  const map = detail?.map;
  const polyline = map?.polyline || map?.summary_polyline;
  return {
    summaryFields: Object.keys(summary),
    responseFields: Object.keys(detailResponse || {}),
    valueIsArray: Array.isArray(wrappedValue),
    detailFields: Object.keys(detail || {}),
    mapFields: Object.keys(map || {}),
    hasPolyline: typeof polyline === "string",
    polylineLength: typeof polyline === "string" ? polyline.length : 0,
    decodedPointCount: typeof polyline === "string" ? decodePolyline(polyline).length : 0
  };
}

function routeHash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function importAthleteRoutes(job) {
  const accessTokenValue = await accessToken();
  const routes = await allAthleteRoutes(accessTokenValue);
  job.total = routes.length;
  for (const summary of routes) {
    try {
      if (!summary?.id) throw new Error("Strava route nemá ID.");
      let detail = summary;
      let polyline = summary.map?.polyline || summary.map?.summary_polyline;
      if (typeof polyline !== "string") {
        const detailResponse = await stravaRequest(`https://www.strava.com/api/v3/routes/${summary.id}`, { headers: { Authorization: `Bearer ${accessTokenValue}` } });
        detail = Array.isArray(detailResponse?.value) ? detailResponse.value[0] : detailResponse?.value || detailResponse;
        polyline = detail.map?.polyline || detail.map?.summary_polyline;
      }
      const points = typeof polyline === "string" ? decodePolyline(polyline) : [];
      if (points.length < 2) throw new Error("bez použiteľnej GPS trasy");
      const route = {
        source: "strava",
        stravaRouteId: summary.id,
        title: detail.name || summary.name || `Strava route ${summary.id}`,
        fileName: `Strava route - ${detail.name || summary.name || summary.id}`,
        points,
        distance: Number(detail.distance || summary.distance || 0) / 1000,
        activityDate: detail.created_at || summary.created_at || null,
        movingSeconds: Number(detail.estimated_moving_time || summary.estimated_moving_time) || null,
        totalSeconds: null,
        movingSpeedKmh: null,
        totalSpeedKmh: null,
        averageHeartRate: null,
        maximumHeartRate: null,
        contentHash: routeHash(`strava-route:${summary.id}`)
      };
      route.routeFingerprint = routeHash(JSON.stringify({ title: route.title, points: route.points.map((point) => [point.lat, point.lon]) }));
      const saved = await databaseRequestAsync("save", { type: "planned", route });
      if (saved.saved) job.imported += 1;
      else job.duplicates += 1;
    } catch (error) { job.skipped += 1; job.errors.push(error.message); }
    job.processed += 1;
  }
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

function routeImportJobStatus() {
  if (!routeImportJob) return { status: "idle", total: 0, processed: 0, imported: 0, duplicates: 0, skipped: 0 };
  return { status: routeImportJob.status, total: routeImportJob.total, processed: routeImportJob.processed, imported: routeImportJob.imported, duplicates: routeImportJob.duplicates, skipped: routeImportJob.skipped, error: routeImportJob.error || null };
}

function startRouteImportJob() {
  if (routeImportJob?.status === "running") return routeImportJobStatus();
  routeImportJob = { status: "running", total: 0, processed: 0, imported: 0, duplicates: 0, skipped: 0, errors: [], error: null };
  importAthleteRoutes(routeImportJob).then(() => { routeImportJob.status = "complete"; }).catch((error) => {
    if (/\b401\b|unauthorized/i.test(error.message)) { token = null; credentialRequest("clear-token"); }
    routeImportJob.error = error.message; routeImportJob.status = "error";
  });
  return routeImportJobStatus();
}

http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  try {
    if (requestUrl.pathname === "/api/routes" && request.method === "GET") return sendJson(response, 200, await databaseRequestAsync("list"));
    if (requestUrl.pathname === "/api/routes/nearby" && request.method === "GET") {
      const result = await databaseRequestAsync("nearby", { lat: requestUrl.searchParams.get("lat"), lon: requestUrl.searchParams.get("lon"), radiusKm: requestUrl.searchParams.get("radiusKm") });
      return sendJson(response, 200, result);
    }
    if (requestUrl.pathname === "/api/routes/search" && request.method === "GET") return sendJson(response, 200, await databaseRequestAsync("search", { query: requestUrl.searchParams.get("query") }));
    if (requestUrl.pathname === "/api/routes" && request.method === "POST") {
      const result = await databaseRequestAsync("save", await readJson(request));
      return sendJson(response, result.saved ? 201 : 200, result);
    }
    const routeDeleteMatch = requestUrl.pathname.match(/^\/api\/routes\/(\d+)$/);
    if (routeDeleteMatch && request.method === "DELETE") {
      const result = await databaseRequestAsync("delete", null, routeDeleteMatch[1]);
      return sendJson(response, result.deleted ? 200 : 404, result);
    }
    if (requestUrl.pathname === "/api/strava/status") return sendJson(response, 200, { connected: Boolean(token), configured: true });
    if (requestUrl.pathname === "/api/strava/authorize") {
      const callbackUrl = `http://${request.headers.host}/api/strava/callback`;
      const nextImport = requestUrl.searchParams.get("next") === "routes" ? "routes" : requestUrl.searchParams.get("next") === "activities" ? "activities" : "none";
      const authorizationUrl = new URL("https://www.strava.com/oauth/authorize");
      authorizationUrl.search = new URLSearchParams({ client_id: credentials.clientId, redirect_uri: callbackUrl, response_type: "code", approval_prompt: "auto", scope: "read,read_all,activity:read_all", state: nextImport }).toString();
      response.writeHead(302, { Location: authorizationUrl }); return response.end();
    }
    if (requestUrl.pathname === "/api/strava/callback") {
      if (!requestUrl.searchParams.get("code")) return sendJson(response, 400, { error: "Strava OAuth neposlala autorizačný kód." });
      const callbackUrl = `http://${request.headers.host}/api/strava/callback`;
      const exchanged = await formRequest({ client_id: credentials.clientId, client_secret: credentials.clientSecret, code: requestUrl.searchParams.get("code"), grant_type: "authorization_code", redirect_uri: callbackUrl });
      token = { accessToken: exchanged.access_token, refreshToken: exchanged.refresh_token, expiresAt: exchanged.expires_at };
      credentialRequest("set-token", token);
      const nextImport = requestUrl.searchParams.get("state") === "routes" ? "routes" : requestUrl.searchParams.get("state") === "activities" ? "activities" : "none";
      response.writeHead(302, { Location: `/?strava=connected&next=${nextImport}` }); return response.end();
    }
    if (requestUrl.pathname === "/api/strava/import" && request.method === "POST") return sendJson(response, 202, startImportJob());
    if (requestUrl.pathname === "/api/strava/import" && request.method === "GET") return sendJson(response, 200, importJobStatus());
    if (requestUrl.pathname === "/api/strava/import/data" && request.method === "GET") {
      if (importJob?.status !== "complete") return sendJson(response, 409, { error: "Strava import ešte nie je dokončený." });
      return sendJson(response, 200, importJob.result);
    }
    if (requestUrl.pathname === "/api/strava/routes/import" && request.method === "POST") return sendJson(response, 202, startRouteImportJob());
    if (requestUrl.pathname === "/api/strava/routes/import" && request.method === "GET") return sendJson(response, 200, routeImportJobStatus());
    if (requestUrl.pathname === "/api/strava/routes/diagnostic" && request.method === "GET") return sendJson(response, 200, await inspectAthleteRoute());
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
