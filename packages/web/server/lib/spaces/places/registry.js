export const REQUIRED_PLACE_METHODS = ['check', 'create', 'list', 'exec', 'stop', 'start', 'remove', 'verify'];

export function createPlaceRegistry(initialPlaces = []) {
  const places = new Map();
  let sealed = false;

  const register = (place) => {
    if (sealed) {
      throw new Error('Place registry is sealed; no further registrations allowed');
    }
    const key = String(place?.id ?? '').trim().toLowerCase();
    if (key.length === 0) {
      throw new Error('Place must define a non-empty id');
    }
    for (const method of REQUIRED_PLACE_METHODS) {
      if (!(place[method] instanceof Function)) {
        throw new Error(`Place '${key}' must implement ${method}()`);
      }
    }
    if (places.has(key)) {
      throw new Error(`Place '${key}' is already registered`);
    }
    places.set(key, place);
    return place;
  };

  const get = (placeId) => places.get(String(placeId ?? '').trim().toLowerCase()) ?? null;

  const list = () => Array.from(places.values());

  for (const place of initialPlaces) {
    register(place);
  }

  const seal = () => { sealed = true; };

  return {
    register,
    get,
    list,
    seal,
  };
}
