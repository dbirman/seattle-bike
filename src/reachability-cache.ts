import type { Coordinate, NetworkSegment, RiskConfig, RoadCollection, RoutingGraph } from './routing'

export interface RoutingGraphCache {
  version: 1
  roadsFingerprint: string
  configFingerprint: string
  binaryFormat: 1
  nodeCount: number
  edgeCount: number
  segmentCount: number
}

export interface ReachabilityCache {
  version: 2
  roadsFingerprint: string
  configFingerprint: string
  segmentCount: number
  distances: number[]
  quantiles: number[]
}

export function fingerprint(value: unknown): string {
  const serialized = JSON.stringify(value)
  let hash = 0x811c9dc5
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function reachabilityConfigFingerprint(config: RiskConfig): string {
  return fingerprint({
    riskDistanceMeters: config.riskDistanceMeters,
    riskRates: config.riskRates,
    roadTypeRules: config.roadTypeRules,
    greenMax: config.colorThresholds.greenMax,
    maxDistanceMiles: config.reachabilityDisplay.maxDistanceMiles,
  })
}

export function createRoutingGraphCache(
  graph: RoutingGraph,
  roadsFingerprint: string,
  configFingerprint: string,
): RoutingGraphCache {
  const edgeCount = [...graph.adjacency.values()].reduce((count, edges) => count + edges.length, 0)
  return {
    version: 1,
    roadsFingerprint,
    configFingerprint,
    binaryFormat: 1,
    nodeCount: graph.nodes.size,
    edgeCount,
    segmentCount: graph.segments.length,
  }
}

export function encodeRoutingGraph(graph: RoutingGraph): Uint8Array {
  const nodeEntries = [...graph.nodes]
  const nodeIndices = new Map(nodeEntries.map(([key], index) => [key, index]))
  const edgeCount = [...graph.adjacency.values()].reduce((count, edges) => count + edges.length, 0)
  const byteLength = nodeEntries.length * 16 + graph.segments.length * 32 +
    (nodeEntries.length + 1) * 4 + edgeCount * 8
  const buffer = new ArrayBuffer(byteLength)
  const view = new DataView(buffer)
  let offset = 0

  for (const [, [longitude, latitude]] of nodeEntries) {
    view.setFloat64(offset, longitude, true)
    view.setFloat64(offset + 8, latitude, true)
    offset += 16
  }
  for (const segment of graph.segments) {
    view.setUint32(offset, nodeIndices.get(segment.from)!, true)
    view.setUint32(offset + 4, nodeIndices.get(segment.to)!, true)
    view.setFloat64(offset + 8, segment.riskRate, true)
    view.setFloat64(offset + 16, segment.distance, true)
    view.setUint32(offset + 24, segment.sourceFeatureIndex, true)
    view.setUint32(offset + 28, segment.sourceCoordinateIndex, true)
    offset += 32
  }

  let edgeOffset = 0
  for (const [key] of nodeEntries) {
    const edges = graph.adjacency.get(key) ?? []
    view.setUint32(offset, edgeOffset, true)
    offset += 4
    edgeOffset += edges.length
  }
  view.setUint32(offset, edgeOffset, true)
  offset += 4
  for (const [key] of nodeEntries) {
    const edges = graph.adjacency.get(key) ?? []
    for (const edge of edges) {
      view.setUint32(offset, nodeIndices.get(edge.to)!, true)
      view.setUint32(offset + 4, edge.segmentIndex, true)
      offset += 8
    }
  }
  return new Uint8Array(buffer)
}

export function isRoutingGraphCache(value: unknown): value is RoutingGraphCache {
  if (!value || typeof value !== 'object') return false
  const cache = value as Partial<RoutingGraphCache>
  return cache.version === 1 &&
    typeof cache.roadsFingerprint === 'string' &&
    typeof cache.configFingerprint === 'string' &&
    cache.binaryFormat === 1 &&
    Number.isInteger(cache.nodeCount) &&
    Number.isInteger(cache.edgeCount) &&
    Number.isInteger(cache.segmentCount)
}

export function restoreRoutingGraphBinary(
  cache: RoutingGraphCache,
  binary: ArrayBuffer,
  riskConfig: RiskConfig,
  sourceCollection: RoadCollection,
): RoutingGraph {
  const expectedBytes = cache.nodeCount * 16 + cache.segmentCount * 32 +
    (cache.nodeCount + 1) * 4 + cache.edgeCount * 8
  if (binary.byteLength !== expectedBytes) throw new Error('Routing graph cache binary length does not match its header')

  const view = new DataView(binary)
  let offset = 0
  const nodeKeys: string[] = []
  const nodes = new Map<string, Coordinate>()
  for (let index = 0; index < cache.nodeCount; index += 1) {
    const coordinate: Coordinate = [view.getFloat64(offset, true), view.getFloat64(offset + 8, true)]
    const key = `${coordinate[0].toFixed(7)},${coordinate[1].toFixed(7)}`
    nodeKeys.push(key)
    nodes.set(key, coordinate)
    offset += 16
  }

  const segments: NetworkSegment[] = []
  for (let index = 0; index < cache.segmentCount; index += 1) {
    const fromIndex = view.getUint32(offset, true)
    const toIndex = view.getUint32(offset + 4, true)
    const from = nodeKeys[fromIndex]
    const to = nodeKeys[toIndex]
    const start = nodes.get(from)!
    const end = nodes.get(to)!
    segments.push({
      segmentIndex: index,
      from,
      to,
      coordinates: [start, end],
      riskRate: view.getFloat64(offset + 8, true),
      distance: view.getFloat64(offset + 16, true),
      sourceFeatureIndex: view.getUint32(offset + 24, true),
      sourceCoordinateIndex: view.getUint32(offset + 28, true),
    })
    offset += 32
  }

  const adjacencyOffsets: number[] = []
  for (let index = 0; index <= cache.nodeCount; index += 1) {
    adjacencyOffsets.push(view.getUint32(offset, true))
    offset += 4
  }
  const edgeTargets = new Uint32Array(cache.edgeCount)
  const edgeSegments = new Uint32Array(cache.edgeCount)
  for (let index = 0; index < cache.edgeCount; index += 1) {
    edgeTargets[index] = view.getUint32(offset, true)
    edgeSegments[index] = view.getUint32(offset + 4, true)
    offset += 8
  }

  const adjacency = new Map<string, { to: string; riskRate: number; distance: number; segmentIndex: number }[]>()
  for (let index = 0; index < cache.nodeCount; index += 1) {
    const edges = []
    for (let edgeIndex = adjacencyOffsets[index]; edgeIndex < adjacencyOffsets[index + 1]; edgeIndex += 1) {
      const segmentIndex = edgeSegments[edgeIndex]
      const segment = segments[segmentIndex]
      edges.push({
        to: nodeKeys[edgeTargets[edgeIndex]],
        riskRate: segment.riskRate,
        distance: segment.distance,
        segmentIndex,
      })
    }
    adjacency.set(nodeKeys[index], edges)
  }

  return {
    nodes,
    adjacency,
    segments,
    riskConfig,
    sourceCollection,
  }
}

export function isReachabilityCache(value: unknown): value is ReachabilityCache {
  if (!value || typeof value !== 'object') return false
  const cache = value as Partial<ReachabilityCache>
  return cache.version === 2 &&
    typeof cache.roadsFingerprint === 'string' &&
    typeof cache.configFingerprint === 'string' &&
    Number.isInteger(cache.segmentCount) &&
    Array.isArray(cache.distances) &&
    Array.isArray(cache.quantiles) &&
    cache.distances.length === cache.segmentCount &&
    cache.distances.every((distance) => typeof distance === 'number' && Number.isFinite(distance)) &&
    cache.quantiles.length === 5 &&
    cache.quantiles.every((distance) => typeof distance === 'number' && Number.isFinite(distance))
}