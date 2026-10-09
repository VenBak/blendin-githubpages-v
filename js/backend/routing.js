// Walking routes that follow real streets and footpaths (OpenStreetMap data), requested from the browser.
//
// Providers are tried in order until one answers:
//   1. OpenRouteService "foot-walking"   if ORS_API_KEY is set in js/config.js
//   2. OSRM foot router                  the FOSSGIS server routing.openstreetmap.de
//   3. Valhalla pedestrian router        the FOSSGIS server valhalla1.openstreetmap.de
// Only if all of them fail is the walk drawn as straight lines, and the reason is logged and shown.
//
// Points between the start and the destination are "through" points: the route must pass through
// them but they are not stops. That is how a recommender reshapes the shortest path.

import { CONFIG } from '../config.js';

const ROUTING_URL = 'https://routing.openstreetmap.de/routed-foot';
const VALHALLA_URL = 'https://valhalla1.openstreetmap.de';
const ORS_API_KEY = CONFIG.ORS_API_KEY || '';
const WALK_KMH = 4.8;
const TIMEOUT_MS = 8000;

let lastError = '';

function haversineKm(a, b) {
  const R = 6371, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const result = (path, km, provider) => ({ path, distanceKm: km, durationMin: Math.round((km / WALK_KMH) * 60), snapped: true, provider, problem: '' });

async function getJson(url, options = {}) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: 'application/json', ...(options.headers || {}) } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function viaOrs(points) {
  const data = await getJson('https://api.openrouteservice.org/v2/directions/foot-walking/geojson', {
    method: 'POST',
    headers: { Authorization: ORS_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ coordinates: points.map((p) => [p.lng, p.lat]) }),
  });
  const f = data.features && data.features[0];
  if (!f) throw new Error('no route found');
  return result(f.geometry.coordinates, f.properties.summary.distance / 1000, 'OpenRouteService');
}

async function viaOsrm(points) {
  const coords = points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
  // OSRM ignores the profile name in the URL: the server's own data decides (walking, on the FOSSGIS foot server).
  const data = await getJson(`${ROUTING_URL}/route/v1/driving/${coords}?overview=full&geometries=geojson&continue_straight=false`);
  const route = data.routes && data.routes[0];
  if (data.code !== 'Ok' || !route) throw new Error(data.message || data.code || 'no route found');
  return result(route.geometry.coordinates, route.distance / 1000, 'OSRM (OpenStreetMap)');
}

// Valhalla returns its line as an encoded polyline with 6 decimal places.
function decodePolyline(str, precision = 6) {
  const factor = Math.pow(10, precision);
  const out = [];
  let index = 0, lat = 0, lng = 0;
  while (index < str.length) {
    for (const which of ['lat', 'lng']) {
      let shift = 0, value = 0, byte;
      do {
        byte = str.charCodeAt(index++) - 63;
        value |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = value & 1 ? ~(value >> 1) : value >> 1;
      if (which === 'lat') lat += delta; else lng += delta;
    }
    out.push([lng / factor, lat / factor]);
  }
  return out;
}

async function viaValhalla(points) {
  const body = {
    locations: points.map((p, i) => ({ lat: p.lat, lon: p.lng, type: i === 0 || i === points.length - 1 ? 'break' : 'through' })),
    costing: 'pedestrian',
    directions_options: { units: 'kilometers' },
  };
  const data = await getJson(`${VALHALLA_URL}/route?json=${encodeURIComponent(JSON.stringify(body))}`);
  if (!data.trip || !data.trip.legs) throw new Error(data.error || 'no route found');
  const path = [];
  for (const leg of data.trip.legs) {
    const line = decodePolyline(leg.shape);
    path.push(...(path.length ? line.slice(1) : line));
  }
  return result(path, data.trip.summary.length, 'Valhalla (OpenStreetMap)');
}

function straightLine(points, problem) {
  let km = 0;
  for (let i = 1; i < points.length; i++) km += haversineKm(points[i - 1], points[i]);
  return { path: points.map((p) => [p.lng, p.lat]), distanceKm: km, durationMin: Math.round((km / WALK_KMH) * 60), snapped: false, provider: 'none', problem };
}

async function walkingRoute(points) {
  if (points.length < 2) throw new Error('A route needs a start and a destination.');
  if (points.length > 25) throw new Error('A route can have at most 25 points.');
  const providers = [];
  if (ORS_API_KEY) providers.push(['OpenRouteService', viaOrs]);
  providers.push(['OSRM', viaOsrm], ['Valhalla', viaValhalla]);
  const errors = [];
  for (const [name, fn] of providers) {
    try {
      const r = await fn(points);
      lastError = '';
      return r;
    } catch (err) {
      errors.push(`${name}: ${err.name === 'TimeoutError' ? 'no answer within 8 s' : err.message}`);
    }
  }
  lastError = errors.join('; ');
  console.warn('[routing] Could not get a street route, using straight lines.', lastError);
  return straightLine(points, `No route service could be reached (${lastError}).`);
}

export { walkingRoute, haversineKm, decodePolyline };
