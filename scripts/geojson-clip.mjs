function sameCoordinate(left, right) {
  return left[0] === right[0] && left[1] === right[1]
}

function clipSegment(start, end, bounds) {
  const deltaX = end[0] - start[0]
  const deltaY = end[1] - start[1]
  const p = [-deltaX, deltaX, -deltaY, deltaY]
  const q = [
    start[0] - bounds.west,
    bounds.east - start[0],
    start[1] - bounds.south,
    bounds.north - start[1],
  ]
  let minimum = 0
  let maximum = 1

  for (let index = 0; index < 4; index += 1) {
    if (p[index] === 0) {
      if (q[index] < 0) return null
      continue
    }
    const ratio = q[index] / p[index]
    if (p[index] < 0) minimum = Math.max(minimum, ratio)
    else maximum = Math.min(maximum, ratio)
    if (minimum > maximum) return null
  }

  return [
    [start[0] + minimum * deltaX, start[1] + minimum * deltaY],
    [start[0] + maximum * deltaX, start[1] + maximum * deltaY],
  ]
}

export function clipLine(coordinates, bounds) {
  const parts = []
  let current = []

  for (let index = 0; index < coordinates.length - 1; index += 1) {
    const clipped = clipSegment(coordinates[index], coordinates[index + 1], bounds)
    if (!clipped) {
      if (current.length > 1) parts.push(current)
      current = []
      continue
    }

    const [start, end] = clipped
    if (current.length && sameCoordinate(current.at(-1), start)) {
      if (!sameCoordinate(current.at(-1), end)) current.push(end)
    } else {
      if (current.length > 1) parts.push(current)
      current = [start, end]
    }
  }

  if (current.length > 1) parts.push(current)
  return parts
}