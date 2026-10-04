export type Coordinate = [number, number]
export type RiskBand = 0 | 1 | 2 | 3

export interface RiskConfig {
  riskDistanceMeters: number
  riskRates: {
    protectedBikeLane: number
    stayHealthyStreet: number
    bicycleFootway: number
    neighborhoodGreenway: number
    neighborhoodStreet: number
    localStreet: number
    arterialStreet: number
    arterialNonProtectedBikeLane: number
    nonProtectedBikeLane: number
    sharrow: number
    parkingAisle: number
    otherRoad: number
    arterialOrHighway: number
  }
  roadTypeRules: {
    neighborhoodMaxLanes: number
    arterialMinLanes: number
    arterialMinSpeedMph: number
    arterialStreetTypes: string[]
  }
  colorThresholds: {
    greenMax: number
    yellowMax: number
    orangeMax: number
  }
  colors: {
    green: string
    yellow: string
    orange: string
    red: string
  }
  reachabilityDisplay: {
    maxDistanceMiles: number
    legendMaxMiles: number
    distanceBandsMiles: [number, number, number, number]
    colors: [string, string, string, string, string]
    title: string
    subtitle: string
    helpText: string
  }
}

export interface RoadFeature {
  type: 'Feature'
  id?: string | number
  properties: Record<string, string | number | undefined>
  geometry: { type: 'LineString'; coordinates: Coordinate[] }
}

export interface RoadCollection {
  type: 'FeatureCollection'
  features: RoadFeature[]
}

export interface NetworkSegment {
  segmentIndex: number
  from: string
  to: string
  coordinates: [Coordinate, Coordinate]
  riskRate: number
  distance: number
  sourceFeatureIndex: number
  sourceCoordinateIndex: number
}

interface DirectedEdge {
  to: string
  riskRate: number
  distance: number
  segmentIndex: number
}

export interface RoutingGraph {
  nodes: Map<string, Coordinate>
  adjacency: Map<string, DirectedEdge[]>
  segments: NetworkSegment[]
  riskConfig: RiskConfig
  sourceCollection: RoadCollection
}

export interface ReachabilityScore {
  risk: number
  distance: number
}

interface QueueEntry extends ReachabilityScore {
  node: string
}

const protectedLaneValues = new Set(['track'])
const separatedValues = new Set(['kerb', 'bollard', 'planter', 'separate', 'guard_rail'])
const sharedLaneValues = new Set(['shared_lane', 'share_busway'])
const laneValues = new Set(['lane', 'opposite_lane'])
const bicycleAllowedValues = new Set(['yes', 'designated', 'permissive', 'destination'])
const highwayTypes = /^(motorway|trunk)(_link)?$/
const localStreetTypes = new Set(['residential', 'living_street', 'unclassified', 'service', 'road'])
const parkingValues = new Set(['parallel', 'perpendicular', 'diagonal', 'marked', 'street_side', 'on_street', 'on_kerb', 'half_on_kerb'])

export function validateRiskConfig(value: unknown): RiskConfig {
  if (!value || typeof value !== 'object') throw new Error('Risk config must be a JSON object')
  const config = value as Partial<RiskConfig>
  const requiredNumbers = [
    config.riskDistanceMeters,
    config.riskRates?.protectedBikeLane,
    config.riskRates?.stayHealthyStreet,
    config.riskRates?.bicycleFootway,
    config.riskRates?.neighborhoodGreenway,
    config.riskRates?.neighborhoodStreet,
    config.riskRates?.localStreet,
    config.riskRates?.arterialStreet,
    config.riskRates?.arterialNonProtectedBikeLane,
    config.riskRates?.nonProtectedBikeLane,
    config.riskRates?.sharrow,
    config.riskRates?.parkingAisle,
    config.riskRates?.otherRoad,
    config.riskRates?.arterialOrHighway,
    config.colorThresholds?.greenMax,
    config.colorThresholds?.yellowMax,
    config.colorThresholds?.orangeMax,
    config.roadTypeRules?.neighborhoodMaxLanes,
    config.roadTypeRules?.arterialMinLanes,
    config.roadTypeRules?.arterialMinSpeedMph,
    config.reachabilityDisplay?.maxDistanceMiles,
    config.reachabilityDisplay?.legendMaxMiles,
    ...(config.reachabilityDisplay?.distanceBandsMiles ?? []),
  ]
  if (requiredNumbers.some((number) => typeof number !== 'number' || !Number.isFinite(number) || number < 0)) {
    throw new Error('Risk rates, distance, and color thresholds must be finite non-negative numbers')
  }
  if (config.riskDistanceMeters === 0) throw new Error('riskDistanceMeters must be greater than zero')
  if (config.reachabilityDisplay!.maxDistanceMiles === 0) {
    throw new Error('Reachability max distance must be greater than zero')
  }
  if (config.reachabilityDisplay!.legendMaxMiles < config.reachabilityDisplay!.distanceBandsMiles[3]) {
    throw new Error('Legend scale must include every reachability distance band')
  }
  if (!Array.isArray(config.reachabilityDisplay!.distanceBandsMiles)) {
    throw new Error('Reachability distance bands must be an array')
  }
  if (
    config.reachabilityDisplay!.distanceBandsMiles.length !== 4 ||
    config.reachabilityDisplay!.distanceBandsMiles.some((distance, index, bands) =>
      distance === 0 || (index > 0 && distance <= bands[index - 1]),
    ) ||
    config.reachabilityDisplay!.distanceBandsMiles[3] > config.reachabilityDisplay!.maxDistanceMiles
  ) throw new Error('Reachability distance bands must increase and fit within maxDistanceMiles')
  if (
    config.reachabilityDisplay!.colors.length !== 5 ||
    config.reachabilityDisplay!.colors.some((color) => typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color))
  ) throw new Error('Reachability display must define five 6-digit hex colors')
  for (const text of [
    config.reachabilityDisplay!.title,
    config.reachabilityDisplay!.subtitle,
    config.reachabilityDisplay!.helpText,
  ]) {
    if (typeof text !== 'string') throw new Error('Reachability display text must be strings')
  }
  if (config.roadTypeRules!.neighborhoodMaxLanes === 0 || config.roadTypeRules!.arterialMinLanes === 0) {
    throw new Error('Road classification lane counts must be greater than zero')
  }
  if (
    !Array.isArray(config.roadTypeRules!.arterialStreetTypes) ||
    config.roadTypeRules!.arterialStreetTypes.some((type) => typeof type !== 'string')
  ) throw new Error('arterialStreetTypes must be an array of highway type strings')
  if (
    config.colorThresholds!.greenMax > config.colorThresholds!.yellowMax ||
    config.colorThresholds!.yellowMax > config.colorThresholds!.orangeMax
  ) throw new Error('Color thresholds must increase from green to orange')
  for (const color of Object.values(config.colors ?? {})) {
    if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) {
      throw new Error('Each configured map color must be a 6-digit hex color')
    }
  }
  if (Object.keys(config.colors ?? {}).length !== 4) {
    throw new Error('Config colors must define green, yellow, orange, and red')
  }
  return config as RiskConfig
}

function classifyRiskRate(tags: RoadFeature['properties'], config: RiskConfig): number {
  const highway = String(tags.highway ?? '')
  const cyclewayTags = Object.entries(tags).filter(([key]) => key.startsWith('cycleway'))
  const hasProtectedLane = highway === 'cycleway' || cyclewayTags.some(([key, value]) => {
    const tagValue = String(value)
    if (protectedLaneValues.has(tagValue)) return true
    return key.endsWith(':separation') && separatedValues.has(tagValue)
  })
  if (hasProtectedLane) return config.riskRates.protectedBikeLane
  if (tags.motor_vehicle === 'destination') return config.riskRates.stayHealthyStreet
  if (highwayTypes.test(highway)) return config.riskRates.arterialOrHighway
  if (highway === 'service' && tags.service === 'parking_aisle') return config.riskRates.parkingAisle
  if (highway === 'footway' && bicycleAllowedValues.has(String(tags.bicycle))) {
    return config.riskRates.bicycleFootway
  }
  const lanes = Number.parseFloat(String(tags.lanes ?? ''))
  const speedTag = String(tags.maxspeed ?? '').trim().match(/^(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh|kph)?$/i)
  const speedMph = speedTag
    ? Number(speedTag[1]) * (/^(km\/h|kmh|kph)$/i.test(speedTag[2] ?? '') ? 0.621371 : 1)
    : null
  const isArterialStreet =
    config.roadTypeRules.arterialStreetTypes.includes(highway) ||
    (lanes >= config.roadTypeRules.arterialMinLanes && speedMph !== null && speedMph >= config.roadTypeRules.arterialMinSpeedMph)
  if (isArterialStreet) {
    return cyclewayTags.some(([, value]) => laneValues.has(String(value)))
      ? config.riskRates.arterialNonProtectedBikeLane
      : config.riskRates.arterialStreet
  }
  if (tags.bicycle === 'designated') return config.riskRates.neighborhoodGreenway
  if (cyclewayTags.some(([, value]) => laneValues.has(String(value)))) return config.riskRates.nonProtectedBikeLane
  if (cyclewayTags.some(([, value]) => sharedLaneValues.has(String(value)))) return config.riskRates.sharrow
  const hasParkingBothSides = parkingValues.has(String(tags['parking:lane:both'] ?? '').toLowerCase()) || (
    parkingValues.has(String(tags['parking:lane:left'] ?? '').toLowerCase()) &&
    parkingValues.has(String(tags['parking:lane:right'] ?? '').toLowerCase())
  )
  if (
    localStreetTypes.has(highway) && lanes > 0 &&
    lanes <= config.roadTypeRules.neighborhoodMaxLanes && hasParkingBothSides
  ) return config.riskRates.neighborhoodStreet
  if (localStreetTypes.has(highway)) return config.riskRates.localStreet
  return config.riskRates.otherRoad
}

function coordinateKey([longitude, latitude]: Coordinate): string {
  return `${longitude.toFixed(7)},${latitude.toFixed(7)}`
}

function segmentDistance(start: Coordinate, end: Coordinate): number {
  const meanLatitude = ((start[1] + end[1]) / 2) * Math.PI / 180
  const deltaX = (end[0] - start[0]) * Math.cos(meanLatitude)
  const deltaY = end[1] - start[1]
  return Math.hypot(deltaX, deltaY) * 111_320
}

function permitsReverseTravel(tags: RoadFeature['properties']): boolean {
  if (tags['oneway:bicycle'] === 'no' || tags['bicycle:oneway'] === 'no') return true
  return ['cycleway', 'cycleway:left', 'cycleway:right', 'cycleway:both'].some((key) =>
    ['opposite', 'opposite_lane', 'opposite_track'].includes(String(tags[key] ?? '')),
  )
}

function isOneWay(tags: RoadFeature['properties']): boolean {
  return ['yes', '1', 'true', '-1'].includes(String(tags.oneway ?? ''))
}

export function buildRoutingGraph(collection: RoadCollection, config: RiskConfig): RoutingGraph {
  const nodes = new Map<string, Coordinate>()
  const adjacency = new Map<string, DirectedEdge[]>()
  const segments: NetworkSegment[] = []

  for (const [featureIndex, feature] of collection.features.entries()) {
    const { coordinates } = feature.geometry
    const riskRate = classifyRiskRate(feature.properties, config)
    const oneWay = isOneWay(feature.properties)
    const reverseOnly = feature.properties.oneway === '-1'
    const allowBoth = !oneWay || permitsReverseTravel(feature.properties)

    for (let index = 0; index < coordinates.length - 1; index += 1) {
      const start = coordinates[index]
      const end = coordinates[index + 1]
      const from = coordinateKey(start)
      const to = coordinateKey(end)
      const distance = segmentDistance(start, end)
      if (distance === 0) continue

      nodes.set(from, start)
      nodes.set(to, end)
      if (!adjacency.has(from)) adjacency.set(from, [])
      if (!adjacency.has(to)) adjacency.set(to, [])
      const segmentIndex = segments.length
      segments.push({
        segmentIndex,
        from,
        to,
        coordinates: [start, end],
        riskRate,
        distance,
        sourceFeatureIndex: featureIndex,
        sourceCoordinateIndex: index,
      })

      if (reverseOnly) {
        adjacency.get(to)!.push({ to: from, riskRate, distance, segmentIndex })
        if (allowBoth) adjacency.get(from)!.push({ to, riskRate, distance, segmentIndex })
      } else {
        adjacency.get(from)!.push({ to, riskRate, distance, segmentIndex })
        if (allowBoth) adjacency.get(to)!.push({ to: from, riskRate, distance, segmentIndex })
      }
    }
  }

  return { nodes, adjacency, segments, riskConfig: config, sourceCollection: collection }
}

function compareScores(left: ReachabilityScore, right: ReachabilityScore): number {
  return left.risk - right.risk || left.distance - right.distance
}

class MinQueue {
  private entries: QueueEntry[] = []

  push(entry: QueueEntry) {
    this.entries.push(entry)
    let index = this.entries.length - 1
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2)
      if (compareScores(this.entries[parent], this.entries[index]) <= 0) break
      ;[this.entries[parent], this.entries[index]] = [this.entries[index], this.entries[parent]]
      index = parent
    }
  }

  pop(): QueueEntry | undefined {
    if (this.entries.length === 0) return undefined
    const first = this.entries[0]
    const last = this.entries.pop()!
    if (this.entries.length === 0) return first
    this.entries[0] = last

    let index = 0
    while (true) {
      const left = index * 2 + 1
      const right = left + 1
      let smallest = index
      if (left < this.entries.length && compareScores(this.entries[left], this.entries[smallest]) < 0) smallest = left
      if (right < this.entries.length && compareScores(this.entries[right], this.entries[smallest]) < 0) smallest = right
      if (smallest === index) break
      ;[this.entries[index], this.entries[smallest]] = [this.entries[smallest], this.entries[index]]
      index = smallest
    }
    return first
  }
}

function nearestNode(graph: RoutingGraph, point: Coordinate): string | null {
  let nearest: string | null = null
  let bestDistance = Infinity
  const latitude = point[1] * Math.PI / 180

  for (const [key, coordinate] of graph.nodes) {
    const deltaLongitude = (coordinate[0] - point[0]) * Math.cos(latitude)
    const deltaLatitude = coordinate[1] - point[1]
    const distance = deltaLongitude ** 2 + deltaLatitude ** 2
    if (distance < bestDistance) {
      nearest = key
      bestDistance = distance
    }
  }
  return nearest
}

export function nearestSegmentLocation(
  graph: RoutingGraph,
  point: Coordinate,
): { segment: NetworkSegment; location: Coordinate; fraction: number } | null {
  let nearestSegment: NetworkSegment | undefined
  let nearestLocation: Coordinate | undefined
  let nearestFraction = 0
  let bestDistanceSquared = Infinity
  const metersPerDegree = 111_320
  const longitudeScale = metersPerDegree * Math.cos(point[1] * Math.PI / 180)

  for (const segment of graph.segments) {
    const [start, end] = segment.coordinates
    const deltaX = (end[0] - start[0]) * longitudeScale
    const deltaY = (end[1] - start[1]) * metersPerDegree
    const pointX = (point[0] - start[0]) * longitudeScale
    const pointY = (point[1] - start[1]) * metersPerDegree
    const lengthSquared = deltaX ** 2 + deltaY ** 2
    const fraction = lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, (pointX * deltaX + pointY * deltaY) / lengthSquared))
    const location: Coordinate = [
      start[0] + (end[0] - start[0]) * fraction,
      start[1] + (end[1] - start[1]) * fraction,
    ]
    const distanceSquared = (pointX - deltaX * fraction) ** 2 + (pointY - deltaY * fraction) ** 2
    if (distanceSquared < bestDistanceSquared) {
      nearestSegment = segment
      nearestLocation = location
      nearestFraction = fraction
      bestDistanceSquared = distanceSquared
    }
  }

  if (!nearestSegment || !nearestLocation) return null
  return { segment: nearestSegment, location: nearestLocation, fraction: nearestFraction }
}

export function splitGraphAtNearestSegment(
  graph: RoutingGraph,
  point: Coordinate,
): { graph: RoutingGraph; location: Coordinate } | null {
  const nearest = nearestSegmentLocation(graph, point)
  if (!nearest) return null
  const { segment: nearestSegment, location: nearestLocation } = nearest
  const locationKey = coordinateKey(nearestLocation)
  const existingNode = graph.nodes.get(locationKey)
  if (existingNode) return { graph, location: existingNode }

  const { sourceFeatureIndex, sourceCoordinateIndex } = nearestSegment
  const features = graph.sourceCollection.features.map((feature, index) => {
    if (index !== sourceFeatureIndex) return feature
    const coordinates = [...feature.geometry.coordinates]
    coordinates.splice(sourceCoordinateIndex + 1, 0, nearestLocation!)
    return { ...feature, geometry: { ...feature.geometry, coordinates } }
  })
  const collection = { ...graph.sourceCollection, features }
  return {
    graph: buildRoutingGraph(collection, graph.riskConfig),
    location: nearestLocation,
  }
}

export function calculateReachability(
  graph: RoutingGraph,
  origin: Coordinate,
  maxRisk = Infinity,
): Map<string, ReachabilityScore> {
  const start = nearestNode(graph, origin)
  if (!start) return new Map()
  return calculateReachabilityFromSeeds(
    graph,
    new Map([[start, { risk: 0, distance: 0 }]]),
    maxRisk,
    Infinity,
  )
}

function calculateReachabilityFromSeeds(
  graph: RoutingGraph,
  seeds: Map<string, ReachabilityScore>,
  maxRisk: number,
  maxDistance: number,
): Map<string, ReachabilityScore> {
  const scores = new Map(seeds)
  const queue = new MinQueue()
  for (const [node, score] of seeds) queue.push({ node, ...score })

  while (true) {
    const current = queue.pop()
    if (!current) break
    const currentScore = scores.get(current.node)
    if (!currentScore || compareScores(current, currentScore) !== 0) continue

    for (const edge of graph.adjacency.get(current.node) ?? []) {
      const candidate: ReachabilityScore = {
        risk: current.risk + edge.riskRate * edge.distance / graph.riskConfig.riskDistanceMeters,
        distance: current.distance + edge.distance,
      }
      if (candidate.risk > maxRisk) continue
      if (candidate.distance > maxDistance) continue
      const previous = scores.get(edge.to)
      if (!previous || compareScores(candidate, previous) < 0) {
        scores.set(edge.to, candidate)
        queue.push({ node: edge.to, ...candidate })
      }
    }
  }

  return scores
}

export function calculateReachabilityFromSegment(
  graph: RoutingGraph,
  segment: NetworkSegment,
  fraction: number,
  maxRisk = Infinity,
): Map<string, ReachabilityScore> {
  const clampedFraction = Math.max(0, Math.min(1, fraction))
  const segmentRiskRate = segment.riskRate / graph.riskConfig.riskDistanceMeters
  const seeds = new Map<string, ReachabilityScore>()
  const addSeed = (node: string, distance: number) => {
    const score = { risk: segmentRiskRate * distance, distance }
    if (score.risk > maxRisk) return
    const existing = seeds.get(node)
    if (!existing || compareScores(score, existing) < 0) seeds.set(node, score)
  }
  const canTravelForward = (graph.adjacency.get(segment.from) ?? []).some((edge) => edge.to === segment.to)
  const canTravelBackward = (graph.adjacency.get(segment.to) ?? []).some((edge) => edge.to === segment.from)

  if (canTravelForward) addSeed(segment.to, segment.distance * (1 - clampedFraction))
  if (canTravelBackward) addSeed(segment.from, segment.distance * clampedFraction)

  return calculateReachabilityFromSeeds(graph, seeds, maxRisk, Infinity)
}

export function calculateGreenReachableDistance(
  graph: RoutingGraph,
  segment: NetworkSegment,
): number {
  const segmentRisk = segment.riskRate * segment.distance / graph.riskConfig.riskDistanceMeters
  const halfRisk = segmentRisk / 2
  const halfDistance = segment.distance / 2
  const maxRisk = graph.riskConfig.colorThresholds.greenMax
  const maxDistance = graph.riskConfig.reachabilityDisplay.maxDistanceMiles * 1609.344
  const seeds = new Map<string, ReachabilityScore>()
  const canTravelForward = (graph.adjacency.get(segment.from) ?? []).some((edge) => edge.to === segment.to)
  const canTravelBackward = (graph.adjacency.get(segment.to) ?? []).some((edge) => edge.to === segment.from)

  if (canTravelForward && halfRisk <= maxRisk) {
    if (halfDistance <= maxDistance) {
      seeds.set(segment.to, { risk: halfRisk, distance: halfDistance })
    }
  }
  if (canTravelBackward && halfRisk <= maxRisk) {
    if (halfDistance <= maxDistance) {
      const existing = seeds.get(segment.from)
      if (!existing || compareScores({ risk: halfRisk, distance: halfDistance }, existing) < 0) {
        seeds.set(segment.from, { risk: halfRisk, distance: halfDistance })
      }
    }
  }

  const reachable = calculateReachabilityFromSeeds(graph, seeds, maxRisk, maxDistance)
  const sourceSegmentIndex = segment.segmentIndex
  let totalDistance = 0
  const reachedEdgeFractions = new Map<number, { forward: number; backward: number }>()
  for (const [node, score] of reachable) {
    for (const edge of graph.adjacency.get(node) ?? []) {
      if (edge.segmentIndex === sourceSegmentIndex) continue
      const fraction = fractionWithinLimits(
        score.risk,
        edge.riskRate * edge.distance / graph.riskConfig.riskDistanceMeters,
        maxRisk,
        score.distance,
        edge.distance,
        maxDistance,
      )
      const direction = node === graph.segments[edge.segmentIndex].from ? 'forward' : 'backward'
      const existing = reachedEdgeFractions.get(edge.segmentIndex) ?? { forward: 0, backward: 0 }
      existing[direction] = Math.max(existing[direction], fraction)
      reachedEdgeFractions.set(edge.segmentIndex, existing)
    }
  }

  const sourceFraction = Math.min(
    halfRisk === 0 ? 1 : maxRisk / halfRisk,
    halfDistance === 0 ? 1 : maxDistance / halfDistance,
    1,
  )
  totalDistance = Math.min(maxDistance,
    (canTravelForward ? halfDistance * sourceFraction : 0) +
    (canTravelBackward ? halfDistance * sourceFraction : 0),
  )
  for (const [segmentIndex, fractions] of reachedEdgeFractions) {
    totalDistance = Math.min(
      maxDistance,
      totalDistance + graph.segments[segmentIndex].distance * Math.min(1, fractions.forward + fractions.backward),
    )
    if (totalDistance >= maxDistance) break
  }

  return totalDistance
}

function fractionWithinLimits(
  currentRisk: number,
  segmentRisk: number,
  maxRisk: number,
  currentDistance: number,
  segmentDistance: number,
  maxDistance: number,
): number {
  if (currentRisk > maxRisk) return 0
  const riskFraction = segmentRisk === 0 ? 1 : (maxRisk - currentRisk) / segmentRisk
  const distanceFraction = segmentDistance === 0 ? 1 : (maxDistance - currentDistance) / segmentDistance
  return Math.max(0, Math.min(1, riskFraction, distanceFraction))
}

export function segmentCumulativeRisk(
  segment: NetworkSegment,
  reachable: Map<string, ReachabilityScore>,
  graph: RoutingGraph,
): number | null {
  const from = reachable.get(segment.from)
  const to = reachable.get(segment.to)
  const segmentRisk = segment.riskRate * segment.distance / graph.riskConfig.riskDistanceMeters
  const canTravelForward = (graph.adjacency.get(segment.from) ?? []).some((edge) => edge.to === segment.to)
  const canTravelBackward = (graph.adjacency.get(segment.to) ?? []).some((edge) => edge.to === segment.from)
  const viaFrom = from && canTravelForward ? from.risk + segmentRisk : Infinity
  const viaTo = to && canTravelBackward ? to.risk + segmentRisk : Infinity
  const cumulativeRisk = Math.min(viaFrom, viaTo)
  return Number.isFinite(cumulativeRisk) ? cumulativeRisk : null
}

export function riskBand(risk: number, thresholds: RiskConfig['colorThresholds']): RiskBand {
  if (risk <= thresholds.greenMax) return 0
  if (risk <= thresholds.yellowMax) return 1
  if (risk <= thresholds.orangeMax) return 2
  return 3
}

export function reachabilityDistanceBand(
  distanceMeters: number,
  display: RiskConfig['reachabilityDisplay'],
): number {
  const band = display.distanceBandsMiles.findIndex((miles) => distanceMeters < miles * 1609.344)
  return band < 0 ? display.colors.length - 1 : band
}
