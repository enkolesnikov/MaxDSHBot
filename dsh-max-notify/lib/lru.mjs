/**
 * Small dependency-free LRU map used for bounded caches (titles, images,
 * schedule choices, goal/TODO state). `Map` preserves insertion order, so
 * deleting and re-inserting on read is enough for LRU semantics.
 */
export function createLruMap({ max = 500 } = {}) {
  const limit = Number.isFinite(Number(max)) && Number(max) > 0 ? Math.trunc(Number(max)) : 500
  const map = new Map()

  function touch(key) {
    const value = map.get(key)
    map.delete(key)
    map.set(key, value)
    return value
  }

  return {
    get(key) {
      if (!map.has(key)) return undefined
      return touch(key)
    },
    set(key, value) {
      if (map.has(key)) map.delete(key)
      map.set(key, value)
      while (map.size > limit) map.delete(map.keys().next().value)
      return value
    },
    has(key) {
      return map.has(key)
    },
    delete(key) {
      return map.delete(key)
    },
    clear() {
      map.clear()
    },
    get size() {
      return map.size
    },
    get max() {
      return limit
    },
    keys() {
      return map.keys()
    },
    values() {
      return map.values()
    },
    entries() {
      return map.entries()
    },
    [Symbol.iterator]() {
      return map[Symbol.iterator]()
    },
  }
}
