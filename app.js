const mapRoutes = [];
const mapColors = ["#0f9a79", "#e95d48", "#376db0", "#bc7a20", "#875b9d"];
const canvas = document.querySelector("#map-canvas");
const mapEmpty = document.querySelector("#map-empty");
const mapLegend = document.querySelector("#map-legend");
const statusMessage = document.querySelector("#status-message");
const importMessage = document.querySelector("#import-message");
const routeResults = document.querySelector("#route-results");
const routeSearch = document.querySelector("#route-search");
const archiveCount = document.querySelector("#archive-count");
const citySearchForm = document.querySelector("#city-search-form");
const citySearch = document.querySelector("#city-search");
const citySearchResult = document.querySelector("#city-search-result");
const comparisonSection = document.querySelector("#comparison-section");
const comparisonResults = document.querySelector("#comparison-results");
const comparisonCount = document.querySelector("#comparison-count");
let storedRoutes = [];
let activeFilter = "all";
let matchingRouteIds = null;
const selectedActualRouteIds = new Set();
let comparisonSort = { key: "activityDate", direction: "desc" };
const offlineCities = { malacky: { name: "Malacky", lat: 48.4365, lon: 17.0219 } };

function setStatus(message) { statusMessage.textContent = message; }
function setImportMessage(message, isWarning = false) { importMessage.textContent = message; importMessage.classList.toggle("is-warning", isWarning); importMessage.hidden = false; }

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("trasy-gpx", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("routes", { keyPath: "id", autoIncrement: true });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveRoute(type, route) {
  const database = await openDatabase();
  await new Promise((resolve, reject) => {
    const request = database.transaction("routes", "readwrite").objectStore("routes").add({ ...route, type, savedAt: new Date().toISOString() });
    request.onsuccess = resolve; request.onerror = () => reject(request.error);
  });
  database.close();
}

async function hashContent(content) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function createRouteFingerprint(route) {
  return JSON.stringify({ title: route.title, points: route.points.map((point) => [point.lat, point.lon, point.time, point.heartRate]) });
}

async function hasStoredDuplicate(contentHash, routeFingerprint) {
  const database = await openDatabase();
  const exists = await new Promise((resolve, reject) => {
    const request = database.transaction("routes").objectStore("routes").getAll();
    request.onsuccess = () => resolve(request.result.some((route) => route.contentHash === contentHash || route.routeFingerprint === routeFingerprint || createRouteFingerprint(route) === routeFingerprint)); request.onerror = () => reject(request.error);
  });
  database.close();
  return exists;
}

async function deleteStoredRoute(route) {
  if (!window.confirm(`Naozaj chceš VYMAZAŤ aktivitu „${route.title}“?`)) return;
  try {
    const database = await openDatabase();
    await new Promise((resolve, reject) => {
      const request = database.transaction("routes", "readwrite").objectStore("routes").delete(route.id);
      request.onsuccess = resolve; request.onerror = () => reject(request.error);
    });
    database.close();
    selectedActualRouteIds.delete(route.id); matchingRouteIds?.delete(route.id);
    const mapRouteIndex = mapRoutes.findIndex((mapRoute) => mapRoute.id === route.id);
    if (mapRouteIndex !== -1) { mapRoutes.splice(mapRouteIndex, 1); drawRoutes(); }
    await loadStoredRoutes(); renderComparison(); setStatus(`Import ${route.title} bol vymazaný.`);
  } catch (error) { setStatus("Import sa nepodarilo vymazať z databázy."); }
}

async function loadStoredRoutes() {
  try {
    const database = await openDatabase();
    storedRoutes = await new Promise((resolve, reject) => {
      const request = database.transaction("routes").objectStore("routes").getAll();
      request.onsuccess = () => resolve(request.result.sort((first, second) => second.id - first.id)); request.onerror = () => reject(request.error);
    });
    database.close(); renderStoredRoutes();
  } catch (error) { setStatus("Databázu trás sa nepodarilo otvoriť."); }
}

function renderStoredRoutes() {
  const searchTerm = routeSearch.value.trim().toLocaleLowerCase("sk-SK");
  const hasSearch = Boolean(searchTerm || matchingRouteIds);
  const visibleRoutes = storedRoutes.filter((route) => (route.type !== "actual" || hasSearch) && (activeFilter === "all" || route.type === activeFilter) && route.title.toLocaleLowerCase("sk-SK").includes(searchTerm) && (!matchingRouteIds || matchingRouteIds.has(route.id)));
  archiveCount.textContent = `${storedRoutes.length} ${storedRoutes.length === 1 ? "trasa" : storedRoutes.length < 5 ? "trasy" : "trás"}`;
  routeResults.replaceChildren();
  if (!visibleRoutes.length) { routeResults.innerHTML = `<li class="empty-results">${storedRoutes.length ? "Pre uskutočnené trasy zadaj názov alebo vyhľadaj mesto. Žiadna trasa nezodpovedá aktuálnemu vyhľadávaniu." : "Databáza je zatiaľ prázdna. Každý nový import sa sem uloží."}</li>`; return; }
  visibleRoutes.forEach((route) => {
    const item = document.createElement("li"); item.className = `route-result ${route.type}`;
    const details = document.createElement("div"); details.className = "route-load";
    details.innerHTML = `<span class="result-type"><i></i>${route.type === "planned" ? "Plánovaná" : "Uskutočnená"}</span><span class="route-result-top"><strong class="result-title"></strong></span><span class="result-detail">${formatDistance(route.distance)} · ${route.points.length.toLocaleString("sk-SK")} bodov</span>`;
    details.querySelector(".result-title").textContent = route.title;
    if (route.source === "strava" && route.stravaActivityId) {
      const stravaLink = document.createElement("a"); stravaLink.className = "strava-activity-link"; stravaLink.href = `https://www.strava.com/activities/${route.stravaActivityId}`; stravaLink.target = "_blank"; stravaLink.rel = "noopener noreferrer"; stravaLink.textContent = "Strava"; stravaLink.title = "Otvoriť aktivitu v Strave";
      details.querySelector(".route-result-top").append(stravaLink);
    }
    if (route.type === "actual") {
      const checkbox = document.createElement("input"); checkbox.className = "route-selector"; checkbox.type = "checkbox"; checkbox.checked = selectedActualRouteIds.has(route.id); checkbox.setAttribute("aria-label", `Vybrať ${route.title} na porovnanie`);
      checkbox.addEventListener("change", () => { checkbox.checked ? selectedActualRouteIds.add(route.id) : selectedActualRouteIds.delete(route.id); renderComparison(); });
      item.append(checkbox);
    }
    const deleteButton = document.createElement("button"); deleteButton.className = "route-delete"; deleteButton.type = "button"; deleteButton.textContent = "×"; deleteButton.title = "Vymazať import"; deleteButton.setAttribute("aria-label", `Vymazať import ${route.title}`);
    deleteButton.addEventListener("click", () => deleteStoredRoute(route));
    const isOnMap = mapRoutes.some((mapRoute) => mapRoute.id === route.id);
    const compareButton = document.createElement("button"); compareButton.className = "route-compare"; compareButton.type = "button"; compareButton.textContent = isOnMap ? "Odobrať" : "Porovnaj"; compareButton.title = isOnMap ? "Odobrať trasu z mapy" : "Pridať trasu na mapu";
    compareButton.addEventListener("click", () => toggleMapRoute(route));
    item.append(details, compareButton, deleteButton); routeResults.append(item);
  });
}

function formatSpeed(speed) { return Number.isFinite(speed) ? `${speed.toFixed(1)} km/h` : "--"; }
function formatHeartRate(heartRate) { return Number.isFinite(heartRate) ? `${Math.round(heartRate)} bpm` : "--"; }
function formatDate(date) { return date ? new Intl.DateTimeFormat("sk-SK", { dateStyle: "medium", timeStyle: "short" }).format(new Date(date)) : "--"; }
function formatDuration(seconds) { if (!Number.isFinite(seconds)) return "--"; const hours = Math.floor(seconds / 3600); const minutes = Math.floor(seconds % 3600 / 60); const remainingSeconds = Math.round(seconds % 60); return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`; }

function renderComparison() {
  const selectedRoutes = storedRoutes.filter((route) => selectedActualRouteIds.has(route.id)).sort((first, second) => compareRouteValues(first, second, comparisonSort));
  comparisonSection.hidden = selectedRoutes.length === 0;
  comparisonCount.textContent = `${selectedRoutes.length} ${selectedRoutes.length === 1 ? "vybraná" : selectedRoutes.length < 5 ? "vybrané" : "vybraných"}`;
  document.querySelectorAll("[data-sort]").forEach((button) => { const isSorted = button.dataset.sort === comparisonSort.key; button.classList.toggle("is-sorted", isSorted); button.classList.toggle("is-descending", isSorted && comparisonSort.direction === "desc"); button.setAttribute("aria-sort", isSorted ? (comparisonSort.direction === "asc" ? "ascending" : "descending") : "none"); });
  comparisonResults.replaceChildren();
  selectedRoutes.forEach((route) => {
    const row = document.createElement("tr");
    [route.title, formatDate(route.activityDate), formatDuration(route.movingSeconds), formatDuration(route.totalSeconds), formatSpeed(route.movingSpeedKmh), formatSpeed(route.totalSpeedKmh), formatHeartRate(route.averageHeartRate), formatHeartRate(route.maximumHeartRate)].forEach((value) => { const cell = document.createElement("td"); cell.textContent = value; row.append(cell); });
    comparisonResults.append(row);
  });
}

function compareRouteValues(first, second, sort) {
  const firstValue = first[sort.key]; const secondValue = second[sort.key];
  const firstMissing = firstValue === null || firstValue === undefined || firstValue === "";
  const secondMissing = secondValue === null || secondValue === undefined || secondValue === "";
  if (firstMissing || secondMissing) return firstMissing === secondMissing ? 0 : firstMissing ? 1 : -1;
  const comparison = typeof firstValue === "string" ? firstValue.localeCompare(secondValue, "sk") : firstValue - secondValue;
  return sort.direction === "asc" ? comparison : -comparison;
}

function toggleMapRoute(route) {
  const routeIndex = mapRoutes.findIndex((mapRoute) => mapRoute.id === route.id);
  if (routeIndex !== -1) {
    mapRoutes.splice(routeIndex, 1); setStatus(`Trasa ${route.title} bola odobratá z porovnania.`);
  } else if (mapRoutes.length === 5) {
    setStatus("Na mape možno porovnávať najviac 5 GPX trás."); return;
  } else {
    mapRoutes.push(route); setStatus(`Trasa ${route.title} bola pridaná na porovnanie.`);
  }
  drawRoutes(); renderStoredRoutes();
}

function haversineDistance(first, second) {
  const radians = Math.PI / 180;
  const earthRadiusKm = 6371;
  const latitudeDelta = (second.lat - first.lat) * radians;
  const longitudeDelta = (second.lon - first.lon) * radians;
  const a = Math.sin(latitudeDelta / 2) ** 2 + Math.cos(first.lat * radians) * Math.cos(second.lat * radians) * Math.sin(longitudeDelta / 2) ** 2;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function findRoutesInCity(event) {
  event.preventDefault();
  const city = citySearch.value.trim();
  if (!city) return;
  const submitButton = citySearchForm.querySelector("button");
  submitButton.disabled = true; matchingRouteIds = null; citySearchResult.hidden = false; citySearchResult.textContent = `Hľadám mesto ${city}...`; renderStoredRoutes();
  try {
    const response = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=sk&q=${encodeURIComponent(city)}`);
    if (!response.ok) throw new Error("Služba pre vyhľadanie mesta nie je momentálne dostupná.");
    const [place] = await response.json();
    if (!place) throw new Error(`Mesto „${city}“ sa na Slovensku nenašlo.`);
    showCityMatches({ name: place.display_name.split(",")[0], lat: Number(place.lat), lon: Number(place.lon) });
  } catch (error) {
    const offlineCity = offlineCities[city.toLocaleLowerCase("sk-SK")];
    if (offlineCity) { showCityMatches(offlineCity, true); }
    else { citySearchResult.textContent = `${error.message} Skontroluj pripojenie a skús znova.`; }
  }
  finally { submitButton.disabled = false; }
}

function showCityMatches(city, isOffline = false) {
  const maximumDistanceKm = 2.5;
  const matches = storedRoutes.filter((route) => route.points.some((point) => haversineDistance(point, city) <= maximumDistanceKm));
  matchingRouteIds = new Set(matches.map((route) => route.id));
  const fallbackNote = isOffline ? " Použitá je lokálna poloha mesta." : "";
  citySearchResult.textContent = matches.length ? `Mesto ${city.name} pretína ${matches.length} ${matches.length === 1 ? "uložená trasa" : "uložené trasy"}; kontrolované body sú do ${maximumDistanceKm.toLocaleString("sk-SK")} km od stredu mesta.${fallbackNote}` : `V žiadnej uloženej trase nebol bod do ${maximumDistanceKm.toLocaleString("sk-SK")} km od stredu mesta ${city.name}.${fallbackNote}`;
  renderStoredRoutes();
}

function parseGpx(content, fallbackName) {
  const documentXml = new DOMParser().parseFromString(content, "application/xml");
  if (documentXml.querySelector("parsererror")) throw new Error("Súbor nie je platný GPX/XML dokument.");
  const points = [...documentXml.querySelectorAll("trkpt, rtept")].map((point) => ({ lat: Number(point.getAttribute("lat")), lon: Number(point.getAttribute("lon")), time: Date.parse(point.querySelector("time")?.textContent || ""), heartRate: Number([...point.querySelectorAll("*")].find((element) => element.localName === "hr")?.textContent) })).filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lon));
  if (points.length < 2) throw new Error("GPX súbor musí obsahovať aspoň dva body trasy.");
  const title = documentXml.querySelector("trk > name, rte > name, metadata > name")?.textContent?.trim() || fallbackName;
  const distance = points.slice(1).reduce((sum, point, index) => sum + haversineDistance(points[index], point), 0);
  const timedIntervals = points.slice(1).map((point, index) => ({ distance: haversineDistance(points[index], point), seconds: (point.time - points[index].time) / 1000 })).filter((interval) => Number.isFinite(interval.seconds) && interval.seconds > 0);
  const totalSeconds = timedIntervals.reduce((sum, interval) => sum + interval.seconds, 0);
  const movingSeconds = timedIntervals.filter((interval) => interval.distance / interval.seconds * 3600 >= 1).reduce((sum, interval) => sum + interval.seconds, 0);
  const heartRates = points.map((point) => point.heartRate).filter(Number.isFinite);
  return { title, points, distance, activityDate: Number.isFinite(points[0].time) ? new Date(points[0].time).toISOString() : null, movingSeconds: movingSeconds || null, totalSeconds: totalSeconds || null, movingSpeedKmh: movingSeconds ? distance / movingSeconds * 3600 : null, totalSpeedKmh: totalSeconds ? distance / totalSeconds * 3600 : null, averageHeartRate: heartRates.length ? heartRates.reduce((sum, rate) => sum + rate, 0) / heartRates.length : null, maximumHeartRate: heartRates.length ? Math.max(...heartRates) : null };
}

function formatDistance(distance) { return distance >= 100 ? `${distance.toFixed(0)} km` : `${distance.toFixed(2)} km`; }

function drawRoutes() {
  const activeRoutes = mapRoutes;
  const context = canvas.getContext("2d");
  const bounds = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(bounds.width * ratio); canvas.height = Math.round(bounds.height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, bounds.width, bounds.height);
  mapEmpty.hidden = activeRoutes.length > 0; mapLegend.hidden = activeRoutes.length === 0;
  mapLegend.replaceChildren(...activeRoutes.map((route, index) => { const label = document.createElement("span"); const line = document.createElement("i"); const text = document.createElement("b"); line.className = "legend-line"; line.style.background = mapColors[index]; text.textContent = route.fileName || route.title; label.append(line, text); return label; }));
  if (!activeRoutes.length) return;
  const points = activeRoutes.flatMap((route) => route.points);
  const minLatitude = Math.min(...points.map((point) => point.lat)); const maxLatitude = Math.max(...points.map((point) => point.lat));
  const minLongitude = Math.min(...points.map((point) => point.lon)); const maxLongitude = Math.max(...points.map((point) => point.lon));
  const latRange = Math.max(maxLatitude - minLatitude, 0.0001); const lonRange = Math.max(maxLongitude - minLongitude, 0.0001); const padding = 38;
  const scale = Math.min((bounds.width - padding * 2) / lonRange, (bounds.height - padding * 2) / latRange);
  const offsetX = (bounds.width - lonRange * scale) / 2 - minLongitude * scale;
  const offsetY = (bounds.height - latRange * scale) / 2 + maxLatitude * scale;
  activeRoutes.forEach((route, index) => {
    context.beginPath(); route.points.forEach((point, index) => { const x = point.lon * scale + offsetX; const y = -point.lat * scale + offsetY; index ? context.lineTo(x, y) : context.moveTo(x, y); });
    context.lineJoin = "round"; context.lineCap = "round"; context.strokeStyle = "rgba(255,255,255,.8)"; context.lineWidth = 7; context.stroke(); context.strokeStyle = mapColors[index]; context.lineWidth = 4; context.stroke();
    [route.points[0], route.points.at(-1)].forEach((point) => { context.beginPath(); context.arc(point.lon * scale + offsetX, -point.lat * scale + offsetY, 5, 0, Math.PI * 2); context.fillStyle = "#fbfcf8"; context.fill(); context.lineWidth = 3; context.strokeStyle = mapColors[index]; context.stroke(); });
  });
}

async function importFile(type, file) {
  if (!file) return;
  try {
    const content = await file.text(); const contentHash = await hashContent(content);
    const parsedRoute = parseGpx(content, file.name.replace(/\.gpx$/i, "")); const routeFingerprint = createRouteFingerprint(parsedRoute);
    if (await hasStoredDuplicate(contentHash, routeFingerprint)) { const message = `GPX ${file.name} už bol importnutý.`; setImportMessage(message, true); setStatus(message); return; }
    const routeToSave = { ...parsedRoute, contentHash, routeFingerprint, fileName: file.name, type };
    await saveRoute(type, routeToSave); const message = `GPX ${file.name} bol importnutý.`; setImportMessage(message); setStatus(message); await loadStoredRoutes();
  }
  catch (error) { const message = `Import sa nepodaril: ${error.message}`; setImportMessage(message, true); setStatus(message); }
}

async function importStravaActivities() {
  const button = document.querySelector("#strava-import");
  button.disabled = true;
  try {
    const statusResponse = await fetch("/api/strava/status");
    const status = await statusResponse.json();
    if (!status.connected) {
      if (!status.configured) throw new Error("Backend nie je nakonfigurovaný. Doplň STRAVA_CLIENT_ID a STRAVA_CLIENT_SECRET do .env.");
      window.location.assign("/api/strava/authorize"); return;
    }
    const startResponse = await fetch("/api/strava/import", { method: "POST" });
    const startResult = await startResponse.json();
    if (startResponse.status === 401) { window.location.assign("/api/strava/authorize"); return; }
    if (!startResponse.ok) throw new Error(startResult.error || "Strava import zlyhal.");
    let progress = startResult;
    while (progress.status === "running") {
      setImportMessage(progress.total ? `Strava: načítaných ${progress.processed} z ${progress.total} aktivít (${progress.imported} s GPS trasou).` : "Strava: načítavam zoznam aktivít...");
      await new Promise((resolve) => setTimeout(resolve, 750));
      const progressResponse = await fetch("/api/strava/import");
      progress = await progressResponse.json();
      if (!progressResponse.ok) throw new Error(progress.error || "Strava import zlyhal.");
    }
    if (progress.status === "error") throw new Error(progress.error || "Strava import zlyhal.");
    const resultResponse = await fetch("/api/strava/import/data");
    const result = await resultResponse.json();
    if (!resultResponse.ok) throw new Error(result.error || "Strava import zlyhal.");
    let saved = 0;
    for (const [index, route] of result.activities.entries()) {
      setImportMessage(`IndexedDB: ukladám ${index + 1} z ${result.activities.length} GPS aktivít (${saved} nových).`);
      const routeFingerprint = createRouteFingerprint(route);
      const contentHash = await hashContent(`strava:${route.stravaActivityId}`);
      if (await hasStoredDuplicate(contentHash, routeFingerprint)) continue;
      await saveRoute("actual", { ...route, contentHash, routeFingerprint, source: "strava" });
      saved += 1;
      if ((index + 1) % 20 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await loadStoredRoutes();
    const message = `Zo Stravy bolo uložených ${saved} z ${result.total} aktivít.${result.skipped.length ? ` ${result.skipped.length} aktivít nemalo dostupnú GPS trasu alebo sa nepodarilo načítať.` : ""}`;
    setImportMessage(message, result.skipped.length > 0); setStatus(message);
  } catch (error) {
    const message = `Strava import sa nepodaril: ${error.message}`;
    setImportMessage(message, true); setStatus(message);
  } finally { button.disabled = false; }
}

for (const type of ["planned", "actual"]) {
  const input = document.querySelector(`#${type}-file`); const dropzone = document.querySelector(`[data-dropzone="${type}"]`);
  input.addEventListener("change", () => importFile(type, input.files[0]));
  ["dragenter", "dragover"].forEach((eventName) => dropzone.addEventListener(eventName, (event) => { event.preventDefault(); dropzone.classList.add("is-dragging"); }));
  ["dragleave", "drop"].forEach((eventName) => dropzone.addEventListener(eventName, (event) => { event.preventDefault(); dropzone.classList.remove("is-dragging"); }));
  dropzone.addEventListener("drop", (event) => importFile(type, event.dataTransfer.files[0]));
  document.querySelector(`[data-clear="${type}"]`).addEventListener("click", () => { input.value = ""; setStatus("Výber súboru bol vyčistený."); });
}
document.querySelector("#fit-routes").addEventListener("click", drawRoutes);
document.querySelector("#strava-import").addEventListener("click", importStravaActivities);
document.querySelector("#reset-comparison").addEventListener("click", () => { mapRoutes.length = 0; drawRoutes(); renderStoredRoutes(); setStatus("Porovnanie bolo resetované."); });
routeSearch.addEventListener("input", renderStoredRoutes);
citySearchForm.addEventListener("submit", findRoutesInCity);
citySearch.addEventListener("input", () => { if (!citySearch.value.trim() && matchingRouteIds) { matchingRouteIds = null; citySearchResult.hidden = true; renderStoredRoutes(); } });
document.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("click", () => { activeFilter = button.dataset.filter; document.querySelectorAll("[data-filter]").forEach((filterButton) => filterButton.classList.toggle("is-active", filterButton === button)); renderStoredRoutes(); }));
document.querySelectorAll("[data-sort]").forEach((button) => button.addEventListener("click", () => { const key = button.dataset.sort; comparisonSort = { key, direction: comparisonSort.key === key && comparisonSort.direction === "asc" ? "desc" : "asc" }; renderComparison(); }));
window.addEventListener("resize", drawRoutes);
drawRoutes();
loadStoredRoutes();
if (new URLSearchParams(window.location.search).get("strava") === "connected") {
  window.history.replaceState({}, "", window.location.pathname);
  setImportMessage("Strava je pripojená. Začínam sťahovať aktivity a GPS body.");
  importStravaActivities();
}