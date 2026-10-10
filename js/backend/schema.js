// The Undercover Tourist "server", running inside the browser. It answers the same GraphQL queries as the
// Node.js versions, but keeps all data in localStorage, so every visitor has their own copy.
import { buildSchema, graphql } from '../../vendor/graphql.mjs';
import { typeDefs } from './typedefs.js';
import { db } from './db.js';
import * as algo from './algo.js';
import { walkingRoute } from './routing.js';
import { CONFIG } from '../config.js';
import * as seedData from './seed.js';

const MOODS = ['slow-mornings', 'golden-hour', 'hidden-history', 'good-food', 'green-escapes', 'by-the-water', 'art-making', 'live-music', 'late-nights'];
const BUDGETS = ['free', 'low', 'medium', 'high'];
const PRODUCTS = { bundle: 299, pass5: 1000, pass10: 1500, monthly: 799, yearly: 3000 };
const schema = buildSchema(typeDefs);

/* ---------- helpers ---------- */

const fail = (m) => { throw new Error(m); };
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const now = () => new Date();

async function hash(password, salt) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + ':' + password));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const randomSalt = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');

const needUser = (ctx) => ctx.user || fail('Log in first.');
const isModerator = (user, city) => !!user && (user.isAdmin || city.moderators.includes(user.id));
function needModerator(ctx, city) {
  const u = needUser(ctx);
  if (!isModerator(u, city)) fail(`Only ${city.name}'s city moderators can do that.`);
  return u;
}
function hasAccess(user, city) {
  if (!user) return false;
  if (isModerator(user, city)) return true;
  if (user.subscriptionUntil && new Date(user.subscriptionUntil) > now()) return true;
  return user.unlockedCities.includes(city.id);
}
const publicUser = (u) => (u ? { id: u.id, name: u.name, homeCity: u.homeCity || '', localSince: u.localSince || null } : null);
const cityBySlug = (slug) => db.one('cities', (c) => c.slug === str(slug, 60).toLowerCase()) || fail('That city does not exist.');

function cityStats() {
  const map = new Map();
  for (const r of db.find('recs', (r) => r.status === 'approved')) {
    const s = map.get(r.city) || { recs: 0, walks: 0 };
    s.recs++;
    if (r.kind === 'walk') s.walks++;
    map.set(r.city, s);
  }
  return map;
}
function cityOut(c, stats, user) {
  const s = stats.get(c.id) || { recs: 0, walks: 0 };
  return {
    ...c, isOpen: c.moderators.length > 0 && s.recs >= 3, recCount: s.recs, walkCount: s.walks,
    moderators: c.moderators.map((id) => publicUser(db.byId('users', id))).filter(Boolean),
    hasAccess: hasAccess(user, c),
  };
}

function voteTotals(recIds, user) {
  const ids = new Set(recIds);
  const map = new Map();
  for (const v of db.find('votes', (v) => ids.has(v.rec))) {
    const t = map.get(v.rec) || { up: 0, down: 0, wUp: 0, wDown: 0, mine: 0 };
    if (v.value > 0) { t.up++; t.wUp += v.weight; } else { t.down++; t.wDown += v.weight; }
    if (user && v.user === user.id) t.mine = v.value;
    map.set(v.rec, t);
  }
  return map;
}
function hourKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) fail('That time is not valid.');
  d.setMinutes(0, 0, 0);
  return d.toISOString();
}

function recOut(r, citySlug, extra = {}) {
  return {
    ...r, citySlug, moods: r.moods || [], stops: r.stops || [], path: r.path || [], bestTime: r.bestTime || '', photoUrl: r.photoUrl || '',
    snapped: r.kind !== 'walk' || !!r.snapped, author: publicUser(db.byId('users', r.author)),
    up: extra.up || 0, down: extra.down || 0, score: extra.score || 0, opacity: extra.opacity == null ? 1 : extra.opacity,
    myVote: extra.mine || 0, busy: extra.busy || null, reviewNote: r.reviewNote || '',
  };
}

function rankRecs(recs, user, citySlug, plannedHour) {
  const totals = voteTotals(recs.map((r) => r.id), user);
  const hour = plannedHour ? hourKey(plannedHour) : null;
  const out = recs.map((r) => {
    const t = totals.get(r.id) || { up: 0, down: 0, wUp: 0, wDown: 0, mine: 0 };
    let S = algo.personalised(algo.wilson(t.wUp, t.wDown), r, user, false);
    let busy = null;
    if (hour) {
      const c = algo.crowd(db.find('plans', (p) => p.rec === r.id && p.hour === hour).length, r.capacity);
      S *= c.factor;
      busy = c.label;
    }
    return { r, t, S, busy, votes: t.up + t.down };
  });
  out.sort((a, b) => b.S - a.S || b.votes - a.votes);
  const fresh = out.filter((x, i) => x.votes < 10 && i >= 4);
  for (let pos = 4; pos < out.length && fresh.length; pos += 5) {
    const item = fresh.shift();
    out.splice(out.indexOf(item), 1);
    out.splice(pos, 0, item);
  }
  const maxS = Math.max(0, ...out.map((x) => x.S));
  return out.map((x) => recOut(x.r, citySlug, { ...x.t, score: x.S, opacity: algo.opacity(x.S, maxS), busy: x.busy }));
}

function passFor(user) {
  const visits = db.find('visits', (v) => v.user === user.id).sort((a, b) => (b.date > a.date ? 1 : -1));
  return {
    visits: visits.map((v) => ({ ...v, cityName: v.cityName || '', note: v.note || '', place: v.rec ? (db.byId('recs', v.rec) || {}).title || null : null })),
    countries: new Set(visits.map((v) => v.countryId)).size,
    cities: new Set(visits.filter((v) => v.cityName).map((v) => v.countryId + ':' + v.cityName.toLowerCase())).size,
    places: visits.filter((v) => v.rec).length,
  };
}

function rewardsFor(user) {
  const recs = db.find('recs', (r) => r.author === user.id && r.status === 'approved');
  if (!recs.length) return { tier: 'None yet', points: 0, nextTier: 'Local', pointsNeeded: 0, approved: 0 };
  const since = daysAgo(30);
  const views = new Map();
  for (const d of db.find('cityDays', (d) => d.day >= since)) views.set(d.city, (views.get(d.city) || 0) + d.views);
  const mean = views.size ? [...views.values()].reduce((a, b) => a + b, 0) / views.size : 0;
  let points = 0;
  for (const r of recs) points += algo.recPoints(db.find('votes', (v) => v.rec === r.id), algo.halfLife(views.get(r.city) || 0, mean));
  const next = algo.nextTier(points);
  return { tier: algo.tierFor(points, recs.length), points: Math.round(points * 10) / 10, nextTier: next && next.name, pointsNeeded: next && next.needs, approved: recs.length };
}

function userOut(u) {
  if (!u) return null;
  const stats = cityStats();
  return {
    ...publicUser(u), email: u.email, isAdmin: !!u.isAdmin, interests: u.interests || [], budget: u.budget || 'medium',
    isRecommender: !!(u.homeCity && u.localSince), credits: u.credits || 0, passTokens: u.passTokens || 0,
    subscriptionUntil: u.subscriptionUntil || null, hasSubscription: !!(u.subscriptionUntil && new Date(u.subscriptionUntil) > now()),
    unlockedCities: u.unlockedCities.map((id) => (db.byId('cities', id) || {}).slug).filter(Boolean),
    moderatorOf: db.find('cities', (c) => u.isAdmin || c.moderators.includes(u.id)).map((c) => cityOut(c, stats, u)),
    rewards: rewardsFor(u),
  };
}

function bump(cityId, field) {
  const d = db.one('cityDays', (x) => x.city === cityId && x.day === today());
  if (d) db.update('cityDays', d.id, { [field]: d[field] + 1 });
  else db.insert('cityDays', { city: cityId, day: today(), views: field === 'views' ? 1 : 0, purchases: field === 'purchases' ? 1 : 0 });
}

function addPeriod(from, months) {
  const d = new Date(Math.max(Date.now(), from ? new Date(from).getTime() : 0));
  d.setMonth(d.getMonth() + months);
  return d.toISOString();
}

/* ---------- resolvers (queries and mutations share one root object) ---------- */

const root = {
  me: (_a, ctx) => userOut(ctx.user),
  config: () => {
    const key = (CONFIG.MAPTILER_KEY || '').trim();
    const tileUrl = CONFIG.TILE_URL || (key ? `https://api.maptiler.com/maps/streets-v2/256/{z}/{x}/{y}.png?key=${encodeURIComponent(key)}` : '');
    const tileAttribution = CONFIG.TILE_URL ? CONFIG.TILE_ATTRIBUTION || '&copy; OpenStreetMap contributors' : key ? '&copy; MapTiler &copy; OpenStreetMap contributors' : '';
    return { paymentsMode: 'blueprint', moods: MOODS, budgets: BUDGETS, tileUrl, tileAttribution };
  },
  cities: (_a, ctx) => { const s = cityStats(); return db.all('cities').map((c) => cityOut(c, s, ctx.user)).filter((c) => c.isOpen); },
  allCities: (_a, ctx) => { const s = cityStats(); return [...db.all('cities')].sort((a, b) => a.name.localeCompare(b.name)).map((c) => cityOut(c, s, ctx.user)); },
  city: ({ slug }, ctx) => cityOut(cityBySlug(slug), cityStats(), ctx.user),
  cityRecs: ({ slug, plannedHour }, ctx) => {
    const city = cityBySlug(slug);
    bump(city.id, 'views');
    const access = hasAccess(ctx.user, city);
    const recs = db.find('recs', (r) => r.city === city.id && r.status === 'approved');
    if (!access) {
      const pick = recs.length ? recs[Math.floor(Math.random() * recs.length)] : null;
      return { city: cityOut(city, cityStats(), ctx.user), access, recs: [], preview: pick ? rankRecs([pick], ctx.user, city.slug, null)[0] : null };
    }
    return { city: cityOut(city, cityStats(), ctx.user), access, recs: rankRecs(recs, ctx.user, city.slug, plannedHour), preview: null };
  },
  rec: ({ id }, ctx) => {
    const r = db.byId('recs', id);
    if (!r) return null;
    const city = db.byId('cities', r.city);
    const own = ctx.user && r.author === ctx.user.id;
    if (r.status !== 'approved' && !own && !isModerator(ctx.user, city)) return null;
    if (r.status === 'approved' && !own && !hasAccess(ctx.user, city)) fail('Unlock this city to see the full recommendation.');
    return rankRecs([r], ctx.user, city.slug, null)[0];
  },
  popular: () => {
    const since = daysAgo(7);
    const per = new Map();
    for (const d of db.find('cityDays', (d) => d.day >= since)) {
      const p = per.get(d.city) || { p: 0, v: 0 };
      p.p += d.purchases; p.v += d.views;
      per.set(d.city, p);
    }
    const stats = cityStats();
    const ranked = [...db.all('cities')].sort((a, b) => ((per.get(b.id) || {}).p || 0) - ((per.get(a.id) || {}).p || 0) || ((per.get(b.id) || {}).v || 0) - ((per.get(a.id) || {}).v || 0));
    const items = ranked.map((c) => cityOut(c, stats, null)).filter((c) => c.isOpen).slice(0, 2)
      .map((c) => ({ kind: 'Bundle', title: c.name, meta: `${c.recCount} recommendations, €2.99`, citySlug: c.slug }));
    const ups = new Map();
    const monthAgo = new Date(Date.now() - 30 * 864e5).toISOString();
    for (const v of db.find('votes', (v) => v.value === 1 && v.createdAt >= monthAgo)) ups.set(v.rec, (ups.get(v.rec) || 0) + 1);
    [...ups.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).forEach(([id, n]) => {
      const r = db.byId('recs', id);
      if (!r || r.status !== 'approved') return;
      const c = db.byId('cities', r.city);
      items.push({ kind: r.kind === 'walk' ? 'Walk' : 'Spot', title: r.title, meta: `${c.name}, ▲ ${n} this month`, citySlug: c.slug });
    });
    return items;
  },
  pass: (_a, ctx) => (ctx.user ? passFor(ctx.user) : null),
  walkingRoute: ({ points }) => walkingRoute(points),
  moderation: ({ slug }, ctx) => {
    const city = cityBySlug(slug);
    needModerator(ctx, city);
    const live = db.find('recs', (r) => r.city === city.id && r.status === 'approved').sort((a, b) => a.title.localeCompare(b.title));
    return {
      city: cityOut(city, cityStats(), ctx.user),
      pending: db.find('recs', (r) => r.city === city.id && r.status === 'pending').map((r) => recOut(r, city.slug)),
      live: live.map((r) => recOut(r, city.slug)),
      reports: db.find('reports', (r) => r.city === city.id && r.status === 'open').map((r) => ({ ...r, recTitle: (db.byId('recs', r.rec) || {}).title || 'Removed', recId: r.rec })),
      approvedCount: live.length,
    };
  },

  register: async (args) => {
    const email = str(args.email, 120).toLowerCase();
    const name = str(args.name, 60);
    if (!name) fail('Add your name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('That email address looks incomplete.');
    if (typeof args.password !== 'string' || args.password.length < 8) fail('Use a password of at least 8 characters.');
    if (db.one('users', (u) => u.email === email)) fail('That email already has an account. Log in instead.');
    const salt = randomSalt();
    const u = db.insert('users', { email, name, salt, passwordHash: await hash(args.password, salt), isAdmin: email === CONFIG.ADMIN_EMAIL.toLowerCase(), interests: [], budget: 'medium', homeCity: '', localSince: null, unlockedCities: [], passTokens: 0, credits: 0, subscriptionUntil: null });
    db.session.set(u.id);
    return userOut(u);
  },
  login: async (args) => {
    const u = db.one('users', (x) => x.email === str(args.email, 120).toLowerCase());
    if (!u || !u.salt || (await hash(String(args.password || ''), u.salt)) !== u.passwordHash) fail('Email or password is wrong. Accounts only exist in the browser they were made in.');
    db.session.set(u.id);
    return userOut(u);
  },
  logout: () => { db.session.clear(); return true; },
  updateProfile: (args, ctx) => {
    const u = needUser(ctx);
    const patch = {};
    if (args.name != null) patch.name = str(args.name, 60) || fail('Add your name.');
    if (args.interests) patch.interests = [...new Set(args.interests.filter((m) => MOODS.includes(m)))];
    if (args.budget != null) patch.budget = BUDGETS.includes(args.budget) ? args.budget : fail('Pick a budget: free, low, medium or high.');
    return userOut(db.update('users', u.id, patch));
  },
  becomeRecommender: ({ homeCity, localSince }, ctx) => {
    const u = needUser(ctx);
    const c = str(homeCity, 60) || fail('Add the city you are a local of.');
    if (!(localSince >= 1900 && localSince <= new Date().getFullYear())) fail('Add the year you became a local there.');
    return userOut(db.update('users', u.id, { homeCity: c, localSince }));
  },
  // Payment blueprint: nothing is charged; access is granted straight away.
  buy: ({ kind, citySlug }, ctx) => {
    const u = needUser(ctx);
    if (!(kind in PRODUCTS)) fail('Unknown product.');
    const city = citySlug ? cityBySlug(citySlug) : null;
    if (kind === 'bundle' && !city) fail('Pick a city for the bundle.');
    const patch = {};
    if (kind === 'bundle') patch.unlockedCities = [...new Set([...u.unlockedCities, city.id])];
    if (kind === 'pass5') patch.passTokens = u.passTokens + 5;
    if (kind === 'pass10') patch.passTokens = u.passTokens + 10;
    if (kind === 'monthly') patch.subscriptionUntil = addPeriod(u.subscriptionUntil, 1);
    if (kind === 'yearly') patch.subscriptionUntil = addPeriod(u.subscriptionUntil, 12);
    db.update('users', u.id, patch);
    db.insert('purchases', { user: u.id, kind, city: city ? city.id : null, amountCents: PRODUCTS[kind], provider: 'blueprint' });
    if (city) bump(city.id, 'purchases');
    return { granted: true, checkoutUrl: null, mode: 'blueprint', me: userOut(db.byId('users', u.id)) };
  },
  unlockCity: ({ slug, using }, ctx) => {
    const u = needUser(ctx);
    const city = cityBySlug(slug);
    if (hasAccess(u, city)) return userOut(u);
    const patch = { unlockedCities: [...u.unlockedCities, city.id] };
    if (using === 'pass') { if (u.passTokens < 1) fail('Your trip pass has no cities left.'); patch.passTokens = u.passTokens - 1; }
    else if (using === 'credit') { if (u.credits < 1) fail('You have no credits yet. Each approved recommendation earns one.'); patch.credits = u.credits - 1; }
    else fail('Choose a trip pass city or a credit.');
    return userOut(db.update('users', u.id, patch));
  },
  redeemCreditsForMonth: (_a, ctx) => {
    const u = needUser(ctx);
    if (u.credits < 3) fail('A month of the subscription costs 3 credits.');
    return userOut(db.update('users', u.id, { credits: u.credits - 3, subscriptionUntil: addPeriod(u.subscriptionUntil, 1) }));
  },
  vote: ({ recId, value }, ctx) => {
    const u = needUser(ctx);
    const r = db.byId('recs', recId);
    if (!r || r.status !== 'approved' || ![1, -1, 0].includes(value)) fail('That vote is not valid.');
    const city = db.byId('cities', r.city);
    if (!hasAccess(u, city)) fail('Unlock this city to vote on its recommendations.');
    if (r.author === u.id) fail('You cannot vote on your own recommendation.');
    const existing = db.one('votes', (v) => v.user === u.id && v.rec === r.id);
    const weight = Date.now() - new Date(u.createdAt).getTime() < 30 * 864e5 ? 0.5 : 1;
    if (value === 0) db.remove('votes', (v) => v.user === u.id && v.rec === r.id);
    else if (existing) db.update('votes', existing.id, { value, weight });
    else db.insert('votes', { user: u.id, rec: r.id, value, weight });
    return rankRecs([r], u, city.slug, null)[0];
  },
  stampVisit: ({ recId, note }, ctx) => {
    const u = needUser(ctx);
    const r = db.byId('recs', recId);
    if (!r || r.status !== 'approved') fail('That place does not exist.');
    const city = db.byId('cities', r.city);
    if (!hasAccess(u, city)) fail('Unlock this city first.');
    if (!db.one('visits', (v) => v.user === u.id && v.rec === r.id)) {
      db.insert('visits', { user: u.id, countryId: city.countryId, countryName: city.country, cityName: city.name, city: city.id, rec: r.id, lat: r.location.lat, lng: r.location.lng, source: 'stamp', date: new Date().toISOString(), note: str(note, 280) });
    }
    return passFor(u);
  },
  addVisit: ({ input }, ctx) => {
    const u = needUser(ctx);
    const countryId = str(input.countryId, 8), countryName = str(input.countryName, 80);
    if (!countryId || !countryName) fail('Pick a country.');
    const date = input.date ? new Date(input.date) : new Date();
    if (Number.isNaN(date.getTime())) fail('That date is not valid.');
    db.insert('visits', { user: u.id, countryId, countryName, cityName: str(input.cityName, 80), lat: input.lat, lng: input.lng, source: 'manual', date: date.toISOString(), note: str(input.note, 280) });
    return passFor(u);
  },
  removeVisit: ({ id }, ctx) => {
    const u = needUser(ctx);
    db.remove('visits', (v) => v.id === id && v.user === u.id);
    return passFor(u);
  },
  planVisit: ({ recId, hour }, ctx) => {
    const u = needUser(ctx);
    const r = db.byId('recs', recId);
    const city = r && db.byId('cities', r.city);
    if (!r || !hasAccess(u, city)) fail('Unlock this city first.');
    const h = hourKey(hour);
    if (!db.one('plans', (p) => p.user === u.id && p.rec === r.id && p.hour === h)) db.insert('plans', { user: u.id, rec: r.id, hour: h });
    return rankRecs([r], u, city.slug, hour)[0];
  },
  createRec: async ({ input }, ctx) => {
    const u = needUser(ctx);
    if (!u.homeCity || !u.localSince) fail('Set up your local profile first: your city and since when you have lived there.');
    const city = cityBySlug(input.citySlug);
    if (!['spot', 'walk'].includes(input.kind)) fail('Choose a spot or a walk.');
    const title = str(input.title, 90) || fail('Give it a title.');
    const description = str(input.description, 2000);
    if (description.length < 20) fail('Describe it in a couple of sentences at least.');
    if (!(input.personalRating >= 1 && input.personalRating <= 5)) fail('Give it your own rating from 1 to 5.');
    if (!(input.priceLevel >= 0 && input.priceLevel <= 3)) fail('Pick a price.');
    const near = (p) => p && Math.abs(p.lat - city.lat) < 0.5 && Math.abs(p.lng - city.lng) < 0.8;
    if (!near(input.location)) fail(`Place the pin inside ${city.name}.`);
    const photo = str(input.photoUrl, 500);
    if (photo && !/^https:\/\/\S+$/i.test(photo)) fail('Photo links must start with https://');
    const doc = { city: city.id, author: u.id, kind: input.kind, title, description, personalRating: Math.round(input.personalRating), priceLevel: Math.round(input.priceLevel), category: str(input.category, 40) || (input.kind === 'walk' ? 'walk' : 'sightseeing'), moods: (input.moods || []).filter((m) => MOODS.includes(m)).slice(0, 3), bestTime: str(input.bestTime, 60), photoUrl: photo, location: input.location, capacity: 40, status: 'pending', reviewNote: '', credited: false, stops: [], path: [], waypoints: [], distanceKm: 0, durationMin: 0, snapped: false, routedBy: '' };
    if (input.kind === 'walk') {
      if (!near(input.destination)) fail(`Place the destination inside ${city.name}.`);
      const waypoints = (input.waypoints || []).filter(near).slice(0, 20);
      const route = await walkingRoute([input.location, ...waypoints, input.destination]);
      Object.assign(doc, { destination: input.destination, waypoints, path: route.path, distanceKm: Math.round(route.distanceKm * 10) / 10, durationMin: route.durationMin, snapped: route.snapped, routedBy: route.provider });
      doc.stops = (input.stops || []).filter(near).slice(0, 12).map((s) => ({ name: str(s.name, 80), description: str(s.description, 300), priceLevel: Math.max(0, Math.min(3, s.priceLevel || 0)), lat: s.lat, lng: s.lng })).filter((s) => s.name);
    }
    return recOut(db.insert('recs', doc), city.slug);
  },
  report: ({ recId, reason, text }, ctx) => {
    const u = needUser(ctx);
    const r = db.byId('recs', recId) || fail('That place does not exist.');
    if (!['closed', 'outdated', 'unsafe', 'discriminatory', 'fake', 'other'].includes(reason)) fail('Pick a reason.');
    db.insert('reports', { rec: r.id, city: r.city, user: u.id, reason, text: str(text, 500), status: 'open' });
    return true;
  },
  reviewRec: ({ recId, action, note }, ctx) => {
    const r = db.byId('recs', recId) || fail('That recommendation does not exist.');
    const city = db.byId('cities', r.city);
    const u = needModerator(ctx, city);
    if (r.author === u.id) fail('Another moderator has to review your own recommendations.');
    const status = { approve: 'approved', changes: 'changes', reject: 'rejected', hide: 'hidden' }[action] || fail('Choose approve, changes, reject or hide.');
    const credit = status === 'approved' && !r.credited;
    db.update('recs', r.id, { status, reviewNote: str(note, 300), credited: r.credited || credit });
    if (credit) { const a = db.byId('users', r.author); if (a) db.update('users', a.id, { credits: (a.credits || 0) + 1 }); }
    return recOut(db.byId('recs', r.id), city.slug);
  },
  handleReport: ({ id, action }, ctx) => {
    const rep = db.byId('reports', id) || fail('That report does not exist.');
    needModerator(ctx, db.byId('cities', rep.city));
    const status = { hide: 'hidden', dismiss: 'dismissed', escalate: 'escalated' }[action] || fail('Choose hide, dismiss or escalate.');
    db.update('reports', rep.id, { status });
    if (status === 'hidden') db.update('recs', rep.rec, { status: 'hidden' });
    return true;
  },
  setCapacity: ({ recId, capacity }, ctx) => {
    const r = db.byId('recs', recId) || fail('That place does not exist.');
    const city = db.byId('cities', r.city);
    needModerator(ctx, city);
    if (!(capacity >= 1 && capacity <= 5000)) fail('Capacity must be between 1 and 5000 visitors an hour.');
    return recOut(db.update('recs', r.id, { capacity }), city.slug);
  },
  appointModerator: ({ slug, email }, ctx) => {
    const u = needUser(ctx);
    if (!u.isAdmin) fail('Only admins can appoint city moderators.');
    const city = cityBySlug(slug);
    const m = db.one('users', (x) => x.email === str(email, 120).toLowerCase()) || fail('No account uses that email in this browser.');
    db.update('cities', city.id, { moderators: [...new Set([...city.moderators, m.id])] });
    return cityOut(db.byId('cities', city.id), cityStats(), u);
  },
  createCity: ({ input }, ctx) => {
    const u = needUser(ctx);
    if (!u.isAdmin) fail('Only admins can add cities.');
    const slug = str(input.slug, 60).toLowerCase();
    if (!/^[a-z0-9-]+$/.test(slug)) fail('Use lowercase letters, numbers and dashes for the address.');
    if (db.one('cities', (c) => c.slug === slug)) fail('A city with that address already exists.');
    return cityOut(db.insert('cities', { ...input, slug, zoom: input.zoom || 14, moderators: [] }), cityStats(), u);
  },
  // Demo only: lets visitors try the moderator screens of a city in their own browser.
  makeMeModerator: ({ slug }, ctx) => {
    const u = needUser(ctx);
    const city = cityBySlug(slug);
    db.update('cities', city.id, { moderators: [...new Set([...city.moderators, u.id])] });
    return userOut(db.byId('users', u.id));
  },
  resetDemo: () => { db.reset(); return true; },
};

/* ---------- seeding and start-up ---------- */

async function seedIfEmpty() {
  if (!db.isEmpty()) return;
  db.init();
  const cityId = {};
  for (const c of seedData.cities) cityId[c.slug] = db.insert('cities', { ...seedData.NL, ...c, moderators: [] }).id;
  const longAgo = new Date(Date.now() - 200 * 864e5).toISOString();
  const mk = (p) => db.insert('users', { email: `${p.key}@seed.blendin.invalid`, name: p.name, salt: '', passwordHash: '', isAdmin: false, interests: [], budget: 'medium', homeCity: p.homeCity || '', localSince: p.localSince || null, unlockedCities: [], passTokens: 0, credits: 0, subscriptionUntil: null, createdAt: longAgo });
  const userId = {};
  for (const p of seedData.people) {
    userId[p.key] = mk(p).id;
    if (p.moderates) { const c = db.byId('cities', cityId[p.moderates]); db.update('cities', c.id, { moderators: [...c.moderators, userId[p.key]] }); }
  }
  const voters = Array.from({ length: 12 }, (_, i) => mk({ key: `voter${i}`, name: `Traveller ${i + 1}` }).id);
  seedData.recs.forEach((r, n) => {
    const base = { city: cityId[r.city], author: userId[r.by], kind: r.kind, title: r.title, description: r.description, personalRating: r.personalRating, priceLevel: r.priceLevel, moods: r.moods, bestTime: r.bestTime, photoUrl: '', capacity: 40, status: 'approved', reviewNote: '', credited: true, waypoints: [], stops: [], path: [], distanceKm: 0, durationMin: 0, snapped: false, routedBy: '' };
    if (r.kind === 'walk') {
      const stops = r.stops.map(([name, description, priceLevel, lat, lng]) => ({ name, description, priceLevel, lat, lng }));
      Object.assign(base, { category: 'walk', stops, location: { lat: stops[0].lat, lng: stops[0].lng }, destination: { lat: stops[stops.length - 1].lat, lng: stops[stops.length - 1].lng }, waypoints: stops.slice(1, -1).map((s) => ({ lat: s.lat, lng: s.lng })), path: stops.map((s) => [s.lng, s.lat]), distanceKm: 1.5 + stops.length * 0.3, durationMin: 30 + stops.length * 15 });
    } else Object.assign(base, { category: 'sightseeing', location: { lat: r.at[0], lng: r.at[1] }, snapped: true });
    const rec = db.insert('recs', { ...base, createdAt: longAgo });
    const ups = Math.max(2, 12 - (n % 6) * 2);
    voters.forEach((v, i) => {
      if (i < ups) db.insert('votes', { user: v, rec: rec.id, value: 1, weight: 1 });
      else if (i === ups && n % 3 === 0) db.insert('votes', { user: v, rec: rec.id, value: -1, weight: 1 });
    });
  });
}

// Demo walks start as straight lines; route them along streets in the background.
async function rerouteWalks() {
  for (const w of db.find('recs', (r) => r.kind === 'walk' && !r.snapped)) {
    const r = await walkingRoute([w.location, ...(w.waypoints || []), w.destination || w.location]);
    if (!r.snapped) return; // no route service reachable right now; try again on the next visit
    db.update('recs', w.id, { path: r.path, distanceKm: Math.round(r.distanceKm * 10) / 10, durationMin: r.durationMin, snapped: true, routedBy: r.provider });
    await new Promise((ok) => setTimeout(ok, 1200));
  }
}

let ready = null;
export function start() {
  if (!ready) ready = seedIfEmpty().then(() => { rerouteWalks().catch((e) => console.warn('[routing]', e)); });
  return ready;
}

export async function execute(source, variableValues) {
  await start();
  const user = db.byId('users', db.session.get());
  return graphql({ schema, source, rootValue: root, contextValue: { user }, variableValues });
}
