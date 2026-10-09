// A tiny database kept in the browser's localStorage. Every visitor has their own copy.
const KEY = 'blendin-db-v1';
const SESSION = 'blendin-session';
const COLLECTIONS = ['users', 'cities', 'recs', 'votes', 'visits', 'plans', 'reports', 'purchases', 'cityDays'];

let data = null;
try { data = JSON.parse(localStorage.getItem(KEY)); } catch { data = null; }

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(data)); }
  catch (e) { console.error('[db] Could not save to localStorage', e); throw new Error('Your browser storage is full, so this could not be saved.'); }
}
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/-/g, '').slice(0, 24);

export const db = {
  isEmpty: () => !data,
  init() { data = Object.fromEntries(COLLECTIONS.map((c) => [c, []])); save(); },
  all: (c) => data[c],
  find: (c, fn) => data[c].filter(fn),
  one: (c, fn) => data[c].find(fn) || null,
  byId: (c, id) => data[c].find((x) => x.id === id) || null,
  insert(c, doc) {
    const d = { id: uid(), createdAt: new Date().toISOString(), ...doc };
    data[c].push(d);
    save();
    return d;
  },
  update(c, id, patch) {
    const d = this.byId(c, id);
    if (!d) return null;
    Object.assign(d, patch);
    save();
    return d;
  },
  remove(c, fn) {
    data[c] = data[c].filter((x) => !fn(x));
    save();
  },
  save,
  reset() {
    localStorage.removeItem(KEY);
    localStorage.removeItem(SESSION);
  },
  session: {
    get: () => localStorage.getItem(SESSION),
    set: (id) => localStorage.setItem(SESSION, id),
    clear: () => localStorage.removeItem(SESSION),
  },
};
