export const REQUIRED_PLACE_METHODS = ['check', 'create', 'list', 'exec', 'execArgv', 'connect', 'stop', 'start', 'remove', 'verify'] as const;

type PlaceRegistration = { id: string } & Record<typeof REQUIRED_PLACE_METHODS[number], (...args: never[]) => void>;

export function createPlaceRegistry<Place extends PlaceRegistration>(initialPlaces: Place[] = []) {
  const places = new Map<string, Place>();
  let sealed = false;

  const register = (place: Place) => {
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

  const get = (placeId: string | null | undefined) => places.get(String(placeId ?? '').trim().toLowerCase()) ?? null;

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
