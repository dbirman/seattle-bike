import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  buildRoutingGraph,
  calculateGreenReachableDistance,
  calculateReachability,
  calculateReachabilityFromSegment,
  nearestSegmentLocation,
  reachabilityDistanceBand,
  riskBand,
  segmentCumulativeRisk,
  splitGraphAtNearestSegment,
  validateRiskConfig,
} from '../src/routing.ts'
import {
  createRoutingGraphCache,
  encodeRoutingGraph,
  fingerprint,
  isReachabilityCache,
  isRoutingGraphCache,
  reachabilityConfigFingerprint,
  restoreRoutingGraphBinary,
} from '../src/reachability-cache.ts'

const config = validateRiskConfig(JSON.parse(readFileSync(new URL('../public/config.json', import.meta.url), 'utf8')))

function road(coordinates, tags) {
  return {
    type: 'Feature',
    properties: tags,
    geometry: { type: 'LineString', coordinates },
  }
}

function network(features, riskConfig = config) {
  return buildRoutingGraph({ type: 'FeatureCollection', features }, riskConfig)
}

test('minimizes accumulated risk even when the lower-risk route is longer', () => {
  const graph = network([
    road([[0, 0], [0.002, 0]], { highway: 'residential' }),
    road([[0, 0], [0, 0.001]], { highway: 'residential', bicycle: 'designated' }),
    road([[0, 0.001], [0.002, 0.001]], { highway: 'residential', bicycle: 'designated' }),
    road([[0.002, 0.001], [0.002, 0]], { highway: 'residential', bicycle: 'designated' }),
  ])
  const reached = calculateReachability(graph, [0, 0])

  assert.ok(reached.get('0.0020000,0.0000000').risk < 10)
  assert.ok(reached.get('0.0020000,0.0000000').distance > graph.segments[0].distance)
  assert.ok(segmentCumulativeRisk(graph.segments[0], reached, graph) > 25)
})

test('starts routing from the clicked point on a road, not a distant endpoint', () => {
  const graph = network([
    road([[0, 0], [0.002, 0]], { highway: 'residential' }),
  ])
  const snapped = splitGraphAtNearestSegment(graph, [0.001, 0])

  assert.ok(snapped)
  assert.deepEqual(snapped.location, [0.001, 0])
  assert.equal(snapped.graph.segments.length, 2)
  const reachable = calculateReachability(snapped.graph, snapped.location)
  const risks = snapped.graph.segments.map((segment) =>
    segmentCumulativeRisk(segment, reachable, snapped.graph),
  )

  assert.ok(risks.every((risk) => risk !== null && riskBand(risk, config.colorThresholds) === 0))
})

test('routes from the projected point on a segment without rebuilding the graph', () => {
  const graph = network([
    road([[0, 0], [0.002, 0]], { highway: 'residential' }),
    road([[0.002, 0], [0.003, 0]], { highway: 'cycleway' }),
  ])
  const beforeSegments = graph.segments
  const snapped = nearestSegmentLocation(graph, [0.001, 0])

  assert.ok(snapped)
  assert.deepEqual(snapped.location, [0.001, 0])
  assert.equal(snapped.fraction, 0.5)
  const reachable = calculateReachabilityFromSegment(graph, snapped.segment, snapped.fraction)

  assert.equal(graph.segments, beforeSegments)
  assert.ok(reachable.get('0.0000000,0.0000000').distance > 0)
  assert.ok(reachable.get('0.0020000,0.0000000').distance > 0)
  assert.ok(reachable.get('0.0030000,0.0000000').risk > 20)
  assert.ok(reachable.get('0.0030000,0.0000000').risk < 25)
})

test('virtual segment origins respect one-way direction', () => {
  const graph = network([
    road([[0, 0], [0.002, 0]], { highway: 'residential', oneway: 'yes' }),
  ])
  const snapped = nearestSegmentLocation(graph, [0.001, 0])
  assert.ok(snapped)

  const reachable = calculateReachabilityFromSegment(graph, snapped.segment, snapped.fraction)
  assert.equal(reachable.has('0.0000000,0.0000000'), false)
  assert.ok(reachable.get('0.0020000,0.0000000').distance > 0)
})

test('calculates distance reachable from a segment within the green-risk budget', () => {
  const graph = network([
    road([[0, 0], [0.001, 0]], { highway: 'residential' }),
  ], validateRiskConfig({
    ...config,
    colorThresholds: { ...config.colorThresholds, greenMax: 5 },
  }))
  const distance = calculateGreenReachableDistance(graph, graph.segments[0])

  assert.ok(distance > 45 && distance < 55)
})

test('green-reachable distance respects one-way travel direction', () => {
  const graph = network([
    road([[0, 0], [0.001, 0]], { highway: 'residential', oneway: 'yes' }),
  ], validateRiskConfig({
    ...config,
    colorThresholds: { ...config.colorThresholds, greenMax: 5 },
  }))
  const distance = calculateGreenReachableDistance(graph, graph.segments[0])

  assert.ok(distance > 20 && distance < 30)
})

test('caps per-segment reachable distance at the configured maximum', () => {
  const graph = network([
    road([[0, 0], [0.1, 0]], { highway: 'cycleway' }),
  ])
  const distance = calculateGreenReachableDistance(graph, graph.segments[0])

  assert.equal(distance, config.reachabilityDisplay.maxDistanceMiles * 1609.344)
})

test('respects one-way streets unless bicycle contra-flow is tagged', () => {
  const oneWayGraph = network([
    road([[0, 0], [0.001, 0]], { highway: 'residential', oneway: 'yes' }),
  ])
  const fromEnd = calculateReachability(oneWayGraph, [0.001, 0])
  assert.equal(fromEnd.has('0.0000000,0.0000000'), false)

  const contraFlowGraph = network([
    road([[0, 0], [0.001, 0]], {
      highway: 'residential',
      oneway: 'yes',
      'oneway:bicycle': 'no',
    }),
  ])
  const contraFlow = calculateReachability(contraFlowGraph, [0.001, 0])
  assert.ok(contraFlow.get('0.0000000,0.0000000').risk > 0)

  const reverseOneWayGraph = network([
    road([[0, 0], [0.001, 0]], {
      highway: 'residential',
      oneway: '-1',
      'oneway:bicycle': 'no',
    }),
  ])
  const reverseContraFlow = calculateReachability(reverseOneWayGraph, [0, 0])
  assert.ok(reverseContraFlow.get('0.0010000,0.0000000').risk > 0)
})

test('assigns the requested risk rates to each road type', () => {
  const graph = network([
    road([[0, 0], [0.001, 0]], { highway: 'primary', 'cycleway:right': 'track', bicycle: 'designated' }),
    road([[0.001, 0], [0.002, 0]], { highway: 'residential', bicycle: 'designated', cycleway: 'shared_lane' }),
    road([[0.002, 0], [0.003, 0]], { highway: 'residential' }),
    road([[0.003, 0], [0.004, 0]], { highway: 'primary' }),
    road([[0.004, 0], [0.005, 0]], { highway: 'residential', cycleway: 'shared_lane' }),
    road([[0.005, 0], [0.006, 0]], {
      highway: 'residential',
      bicycle: 'designated',
      cycleway: 'shared_lane',
      motor_vehicle: 'destination',
    }),
    road([[0.006, 0], [0.007, 0]], {
      highway: 'service',
      service: 'parking_aisle',
      lanes: '2',
      maxspeed: '35 mph',
    }),
    road([[0.007, 0], [0.008, 0]], { highway: 'footway', bicycle: 'yes' }),
    road([[0.008, 0], [0.009, 0]], { highway: 'footway', bicycle: 'designated' }),
    road([[0.009, 0], [0.01, 0]], { highway: 'footway', bicycle: 'no' }),
    road([[0.006, 0], [0.007, 0]], {
      name: 'West Nickerson Street',
      highway: 'primary',
      bicycle: 'designated',
      cycleway: 'shared_lane',
    }),
  ])

  assert.deepEqual(graph.segments.map((segment) => segment.riskRate), [
    0,
    1,
    20,
    config.riskRates.arterialStreet,
    config.riskRates.sharrow,
    0,
    config.riskRates.parkingAisle,
    config.riskRates.bicycleFootway,
    config.riskRates.bicycleFootway,
    config.riskRates.otherRoad,
    config.riskRates.arterialStreet,
  ])
})

test('assigns a separate rate to unprotected bike lanes on arterials', () => {
  const graph = network([
    road([[0, 0], [0.001, 0]], {
      highway: 'secondary',
      lanes: '2',
      maxspeed: '25 mph',
      bicycle: 'designated',
      cycleway: 'lane',
    }),
    road([[0.001, 0], [0.002, 0]], {
      highway: 'secondary',
      cycleway: 'shared_lane',
    }),
    road([[0.002, 0], [0.003, 0]], { highway: 'secondary' }),
  ])

  assert.deepEqual(graph.segments.map((segment) => segment.riskRate), [
    10,
    config.riskRates.arterialStreet,
    config.riskRates.arterialStreet,
  ])
})

test('distinguishes neighborhood, local, and arterial streets from OSM tags', () => {
  const graph = network([
    road([[0, 0], [0.001, 0]], {
      highway: 'residential',
      lanes: '1',
      'parking:lane:left': 'parallel',
      'parking:lane:right': 'parallel',
    }),
    road([[0.001, 0], [0.002, 0]], { highway: 'residential', lanes: '2', maxspeed: '25 mph' }),
    road([[0.002, 0], [0.003, 0]], { highway: 'residential', lanes: '2', maxspeed: '30 mph' }),
    road([[0.003, 0], [0.004, 0]], { highway: 'secondary' }),
    road([[0.004, 0], [0.005, 0]], { highway: 'residential', lanes: '1', 'parking:lane:both': 'no_stopping' }),
    road([[0.005, 0], [0.006, 0]], { highway: 'pedestrian' }),
  ])

  assert.deepEqual(graph.segments.map((segment) => segment.riskRate), [
    8,
    20,
    config.riskRates.arterialStreet,
    config.riskRates.arterialStreet,
    20,
    5,
  ])
})

test('classifies Golden Gardens footways separately from road-sidewalk tags', () => {
  const graph = network([
    road([[0, 0], [0.001, 0]], {
      name: 'Trail #7',
      highway: 'footway',
      footway: 'sidewalk',
      bicycle: 'yes',
      surface: 'asphalt',
    }),
    road([[0.001, 0], [0.002, 0]], {
      name: 'Trail #7',
      highway: 'footway',
      bicycle: 'yes',
    }),
    road([[0.002, 0], [0.003, 0]], {
      name: 'Trail #8',
      highway: 'footway',
      bicycle: 'yes',
      surface: 'concrete',
    }),
    road([[0.003, 0], [0.004, 0]], {
      name: 'Golden Gardens Drive Northwest',
      highway: 'tertiary',
      sidewalk: 'left',
      bicycle: 'designated',
    }),
    road([[0.004, 0], [0.005, 0]], {
      name: 'Seaview Avenue Northwest',
      highway: 'secondary',
      sidewalk: 'separate',
      bicycle: 'designated',
    }),
    road([[0.005, 0], [0.006, 0]], {
      highway: 'residential',
      sidewalk: 'both',
    }),
  ])

  assert.deepEqual(graph.segments.map((segment) => segment.riskRate), [
    config.riskRates.bicycleFootway,
    config.riskRates.bicycleFootway,
    config.riskRates.bicycleFootway,
    config.riskRates.arterialStreet,
    config.riskRates.arterialStreet,
    config.riskRates.localStreet,
  ])
})

test('a zero-risk bicycle footway can display red after a high-risk approach', () => {
  const graph = network([
    road([[0, 0], [0.02, 0]], { highway: 'residential' }),
    road([[0.02, 0], [0.021, 0]], {
      highway: 'footway',
      footway: 'sidewalk',
      bicycle: 'yes',
    }),
  ])
  const footway = graph.segments[1]
  const reachable = calculateReachability(graph, [0, 0])
  const cumulativeRisk = segmentCumulativeRisk(footway, reachable, graph)

  assert.equal(footway.riskRate, config.riskRates.bicycleFootway)
  assert.ok(cumulativeRisk > config.colorThresholds.orangeMax)
  assert.equal(riskBand(cumulativeRisk, config.colorThresholds), 3)
})

test('maps accumulated risk to color bands at the requested thresholds', () => {
  assert.equal(riskBand(0, config.colorThresholds), 0)
  assert.equal(riskBand(50, config.colorThresholds), 0)
  assert.equal(riskBand(50.01, config.colorThresholds), 1)
  assert.equal(riskBand(100, config.colorThresholds), 1)
  assert.equal(riskBand(100.01, config.colorThresholds), 2)
  assert.equal(riskBand(200, config.colorThresholds), 2)
  assert.equal(riskBand(200.01, config.colorThresholds), 3)
})

test('maps reachable distances to fixed mile bands from config', () => {
  const miles = (distance) => distance * 1609.344

  assert.equal(reachabilityDistanceBand(miles(0.49), config.reachabilityDisplay), 0)
  assert.equal(reachabilityDistanceBand(miles(0.5), config.reachabilityDisplay), 1)
  assert.equal(reachabilityDistanceBand(miles(1), config.reachabilityDisplay), 2)
  assert.equal(reachabilityDistanceBand(miles(2), config.reachabilityDisplay), 3)
  assert.equal(reachabilityDistanceBand(miles(5), config.reachabilityDisplay), 4)
})

test('uses edited rates, distance units, and color thresholds from config', () => {
  const customConfig = validateRiskConfig({
    ...config,
    riskDistanceMeters: 50,
    riskRates: { ...config.riskRates, localStreet: 40 },
    colorThresholds: { greenMax: 5, yellowMax: 15, orangeMax: 50 },
  })
  const graph = network([
    road([[0, 0], [0.001, 0]], { highway: 'residential' }),
  ], customConfig)
  const scores = calculateReachability(graph, [0, 0])

  assert.equal(graph.segments[0].riskRate, 40)
  assert.ok(scores.get('0.0010000,0.0000000').risk > 80)
  assert.equal(riskBand(51, customConfig.colorThresholds), 3)
})

test('rejects invalid configuration values', () => {
  assert.throws(() => validateRiskConfig({ ...config, riskDistanceMeters: 0 }))
  assert.throws(() => validateRiskConfig({
    ...config,
    colorThresholds: { greenMax: 25, yellowMax: 10, orangeMax: 100 },
  }))
  assert.throws(() => validateRiskConfig({
    ...config,
    reachabilityDisplay: { ...config.reachabilityDisplay, distanceBandsMiles: [0.5, 1, 1, 5] },
  }))
})

test('validates precomputed reachability cache shape and fingerprints', () => {
  const roads = { type: 'FeatureCollection', features: [] }
  const cache = {
    version: 2,
    roadsFingerprint: fingerprint(roads),
    configFingerprint: reachabilityConfigFingerprint(config),
    segmentCount: 1,
    distances: [125],
    quantiles: [10, 20, 30, 40, 50],
  }

  assert.equal(isReachabilityCache(cache), true)
  assert.equal(isReachabilityCache({ ...cache, distances: [] }), false)
  assert.notEqual(fingerprint(roads), fingerprint(config))
  assert.equal(
    reachabilityConfigFingerprint(config),
    reachabilityConfigFingerprint({
      ...config,
      reachabilityDisplay: { ...config.reachabilityDisplay, title: 'A different title' },
    }),
  )
})

test('restores a precomputed routing graph with its source roads and config', () => {
  const roads = {
    type: 'FeatureCollection',
    features: [road([[0, 0], [0.001, 0]], { highway: 'residential' })],
  }
  const graph = buildRoutingGraph(roads, config)
  const cache = createRoutingGraphCache(graph, fingerprint(roads), reachabilityConfigFingerprint(config))
  const restored = restoreRoutingGraphBinary(cache, encodeRoutingGraph(graph).buffer, config, roads)

  assert.equal(isRoutingGraphCache(cache), true)
  assert.equal(restored.nodes.size, graph.nodes.size)
  assert.deepEqual(restored.adjacency.get('0.0000000,0.0000000'), graph.adjacency.get('0.0000000,0.0000000'))
  assert.deepEqual(restored.segments, graph.segments)
  assert.equal(restored.sourceCollection, roads)
})
