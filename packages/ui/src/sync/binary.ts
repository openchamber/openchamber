// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Binary {
  export function search<T>(
    array: readonly T[],
    id: string,
    compare: (item: T) => string,
  ): { found: boolean; index: number } {
    let left = 0
    let right = array.length - 1

    while (left <= right) {
      const mid = Math.floor((left + right) / 2)
      const midId = compare(array[mid])

      if (midId === id) {
        return { found: true, index: mid }
      } else if (midId < id) {
        left = mid + 1
      } else {
        right = mid - 1
      }
    }

    return { found: false, index: left }
  }

  /**
   * Binary search against a full ordering comparator (e.g. messages ordered
   * by `time.created`, then id). Returns the insertion index when absent.
   */
  export function searchBy<T>(
    array: readonly T[],
    value: T,
    compare: (left: T, right: T) => number,
  ): { found: boolean; index: number } {
    let left = 0
    let right = array.length - 1

    while (left <= right) {
      const mid = Math.floor((left + right) / 2)
      const comparison = compare(array[mid], value)

      if (comparison === 0) {
        return { found: true, index: mid }
      } else if (comparison < 0) {
        left = mid + 1
      } else {
        right = mid - 1
      }
    }

    return { found: false, index: left }
  }
}
