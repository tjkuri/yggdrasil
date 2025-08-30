// Tiny in-memory cache with timestamp, TTL checked on get()

const store = new Map(); // key -> { v: any, t: number }

function get(key, ttlMs) {
  const hit = store.get(key);
  if (!hit) return null;
  if (ttlMs && Date.now() - hit.t > ttlMs) return null;
  return hit.v;
}

function set(key, value) {
  store.set(key, { v: value, t: Date.now() });
}

function del(key) {
  store.delete(key);
}

function clear() {
  store.clear();
}

module.exports = { get, set, del, clear };
