import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import './App.css'
import {
  buildRoutingGraph,
  calculateReachabilityFromSegment,
  nearestSegmentLocation,
  reachabilityDistanceBand,
  riskBand,
  segmentCumulativeRisk,
  type RoadCollection,
  type RiskConfig,
  type RoutingGraph,
  validateRiskConfig,
} from './routing'
import {
  fingerprint,
  isReachabilityCache,
  isRoutingGraphCache,
  reachabilityConfigFingerprint,
  restoreRoutingGraphBinary,
} from './reachability-cache'

const seattleBounds = L.latLngBounds([47.49, -122.45], [47.75, -122.22])
const comfortCellDegrees = 0.02

function comfortCellKey(coordinates: [number, number][]): string {
  const longitude = (coordinates[0][0] + coordinates[coordinates.length - 1][0]) / 2
  const latitude = (coordinates[0][1] + coordinates[coordinates.length - 1][1]) / 2
  const x = Math.floor((longitude + 122.45) / comfortCellDegrees)
  const y = Math.floor((latitude - 47.49) / comfortCellDegrees)
  return `${x}:${y}`
}

function comfortBand(risk: number | null, graph: RoutingGraph): number {
  return risk === null ? 4 : riskBand(risk, graph.riskConfig.colorThresholds)
}

function comfortBandStyle(band: number, graph: RoutingGraph): L.PathOptions {
  const colors = [
    graph.riskConfig.colors.green,
    graph.riskConfig.colors.yellow,
    graph.riskConfig.colors.orange,
    graph.riskConfig.colors.red,
    '#aeb8b5',
  ]
  return {
    color: colors[band],
    opacity: band === 4 ? 0.34 : 0.9,
    weight: band === 4 ? 1.2 : 2.7,
    lineCap: 'round',
    lineJoin: 'round',
  }
}

function originSplitRisks(
  graph: RoutingGraph,
  segment: RoutingGraph['segments'][number],
  fraction: number,
  reachable: Map<string, { risk: number; distance: number }>,
): [number | null, number | null] {
  const forward = (graph.adjacency.get(segment.from) ?? []).some((edge) => edge.to === segment.to)
  const backward = (graph.adjacency.get(segment.to) ?? []).some((edge) => edge.to === segment.from)
  const ratePerMeter = segment.riskRate / graph.riskConfig.riskDistanceMeters
  const startScore = reachable.get(segment.from)
  const endScore = reachable.get(segment.to)
  const firstRisk = [
    backward ? ratePerMeter * segment.distance * fraction : Infinity,
    forward && startScore ? startScore.risk + ratePerMeter * segment.distance * fraction : Infinity,
  ]
  const secondRisk = [
    forward ? ratePerMeter * segment.distance * (1 - fraction) : Infinity,
    backward && endScore ? endScore.risk + ratePerMeter * segment.distance * (1 - fraction) : Infinity,
  ]
  const first = Math.min(...firstRisk)
  const second = Math.min(...secondRisk)
  return [Number.isFinite(first) ? first : null, Number.isFinite(second) ? second : null]
}

function countRoadSegments(roads: RoadCollection): number {
  let count = 0
  for (const feature of roads.features) {
    const coordinates = feature.geometry.coordinates
    for (let index = 0; index < coordinates.length - 1; index += 1) {
      const start = coordinates[index]
      const end = coordinates[index + 1]
      if (start[0] !== end[0] || start[1] !== end[1]) count += 1
    }
  }
  return count
}

function createDistanceFeatures(roads: RoadCollection, distances: number[]): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature<GeoJSON.LineString, { distance: number }>[] = []
  let segmentIndex = 0
  for (const road of roads.features) {
    const coordinates = road.geometry.coordinates
    for (let index = 0; index < coordinates.length - 1; index += 1) {
      const start = coordinates[index]
      const end = coordinates[index + 1]
      if (start[0] === end[0] && start[1] === end[1]) continue
      features.push({
        type: 'Feature',
        id: segmentIndex,
        properties: { distance: distances[segmentIndex] ?? 0 },
        geometry: { type: 'LineString', coordinates: [start, end] },
      })
      segmentIndex += 1
    }
  }
  return { type: 'FeatureCollection', features }
}

function App() {
  const mapElement = useRef<HTMLDivElement>(null)
  const graphRef = useRef<RoutingGraph | null>(null)
  const graphPromiseRef = useRef<Promise<RoutingGraph> | null>(null)
  const roadsRef = useRef<RoadCollection | null>(null)
  const riskConfigRef = useRef<RiskConfig | null>(null)
  const roadsFingerprintRef = useRef<string | null>(null)
  const configFingerprintRef = useRef<string | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const baseLayerRef = useRef<L.GeoJSON | null>(null)
  const reachabilityLayerRef = useRef<L.GeoJSON | null>(null)
  const comfortLayerRef = useRef<L.LayerGroup | null>(null)
  const comfortBandLayersRef = useRef<Map<string, L.Polyline>>(new Map())
  const originMarkerRef = useRef<L.CircleMarker | null>(null)
  const workerRef = useRef<Worker | null>(null)
  const modeRef = useRef<'green-distance' | 'comfort'>('green-distance')
  const [mode, setMode] = useState<'green-distance' | 'comfort'>('green-distance')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [roadsReady, setRoadsReady] = useState(false)
  const [greenDistances, setGreenDistances] = useState<number[] | null>(null)
  const [calculationProgress, setCalculationProgress] = useState(0)
  const [calculationTotal, setCalculationTotal] = useState(0)
  const [reachabilityDisplay, setReachabilityDisplay] = useState<RiskConfig['reachabilityDisplay'] | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)

  const changeMode = (nextMode: 'green-distance' | 'comfort') => {
    modeRef.current = nextMode
    setMode(nextMode)
    setSettingsOpen(false)
  }

  useEffect(() => {
    if (!mapElement.current) return

    const mapContainer = mapElement.current
    let disposed = false
    const map = L.map(mapContainer, {
      zoomControl: false,
      preferCanvas: true,
      zoomSnap: 0.5,
    })
    mapRef.current = map
    map.setView([47.65, -122.35], 12)

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map)
    L.control.zoom({ position: 'bottomright' }).addTo(map)

    const selectOrigin = (event: MouseEvent) => {
      if (modeRef.current !== 'comfort') return
      const graph = graphRef.current
      if (event.target instanceof Element && event.target.closest('.leaflet-control')) return
      const clickedLocation = map.mouseEventToLatLng(event)
      if (!graph || !seattleBounds.contains(clickedLocation)) return

      const snapped = nearestSegmentLocation(graph, [clickedLocation.lng, clickedLocation.lat])
      if (!snapped) return
      const location = L.latLng(snapped.location[1], snapped.location[0])
      const reachable = calculateReachabilityFromSegment(graph, snapped.segment, snapped.fraction)
      if (reachable.size === 0) return

      if (!comfortLayerRef.current) {
        comfortLayerRef.current = L.layerGroup()
      }

      const segmentsByCellAndBand = new Map<string, L.LatLngTuple[][]>()
      const addSegment = (coordinates: [number, number][], band: number) => {
        const cellKey = comfortCellKey(coordinates)
        const groupKey = `${cellKey}:${band}`
        let lines = segmentsByCellAndBand.get(groupKey)
        if (!lines) {
          lines = []
          segmentsByCellAndBand.set(groupKey, lines)
        }
        lines.push(coordinates.map(([longitude, latitude]) => [latitude, longitude]))
      }
      for (const [index, segment] of graph.segments.entries()) {
        const risk = segmentCumulativeRisk(segment, reachable, graph)
        const isSplitOrigin = index === snapped.segment.segmentIndex && snapped.fraction > 0 && snapped.fraction < 1
        if (isSplitOrigin) continue
        addSegment(segment.coordinates, comfortBand(risk, graph))
      }

      if (snapped.fraction > 0 && snapped.fraction < 1) {
        const [firstRisk, secondRisk] = originSplitRisks(graph, snapped.segment, snapped.fraction, reachable)
        const [start, end] = snapped.segment.coordinates
        addSegment([start, snapped.location], comfortBand(firstRisk, graph))
        addSegment([snapped.location, end], comfortBand(secondRisk, graph))
      }

      for (const [groupKey, lines] of segmentsByCellAndBand) {
        let layer = comfortBandLayersRef.current.get(groupKey)
        if (!layer) {
          const band = Number(groupKey.slice(groupKey.lastIndexOf(':') + 1))
          layer = L.polyline(lines, { ...comfortBandStyle(band, graph), interactive: false })
          comfortBandLayersRef.current.set(groupKey, layer)
          comfortLayerRef.current.addLayer(layer)
        } else {
          layer.setLatLngs(lines)
        }
      }
      for (const [groupKey, layer] of comfortBandLayersRef.current) {
        if (!segmentsByCellAndBand.has(groupKey)) layer.setLatLngs([])
      }
      baseLayerRef.current?.remove()
      comfortLayerRef.current.addTo(map)
      originMarkerRef.current?.remove()
      originMarkerRef.current = L.circleMarker(location, {
        radius: 6,
        color: '#fff',
        weight: 2,
        fillColor: '#202b28',
        fillOpacity: 1,
        interactive: false,
      }).addTo(map)
    }

    mapContainer.addEventListener('click', selectOrigin, true)

    Promise.all([
      fetch(`${import.meta.env.BASE_URL}data/seattle-highways.geojson`).then((response) => {
        if (!response.ok) throw new Error(`Road data request failed: ${response.status}`)
        return response.json() as Promise<RoadCollection>
      }),
      fetch(`${import.meta.env.BASE_URL}config.json`).then((response) => {
        if (!response.ok) throw new Error(`Risk config request failed: ${response.status}`)
        return response.json() as Promise<unknown>
      }),
      fetch(`${import.meta.env.BASE_URL}data/seattle-reachability.json`).then((response) => response.ok ? response.json() as Promise<unknown> : null).catch(() => null),
    ])
      .then(([roads, configData, cacheData]) => {
        if (disposed) return
        const config = validateRiskConfig(configData)
        const segmentCount = countRoadSegments(roads)
        roadsRef.current = roads
        riskConfigRef.current = config
        setReachabilityDisplay(config.reachabilityDisplay)
        const roadsFingerprint = fingerprint(roads)
        const configFingerprint = reachabilityConfigFingerprint(config)
        roadsFingerprintRef.current = roadsFingerprint
        configFingerprintRef.current = configFingerprint
        const cacheKey = `seattle-reachability-${roadsFingerprint}-${configFingerprint}`
        let cachedResult = isReachabilityCache(cacheData) &&
          cacheData.segmentCount === segmentCount &&
          cacheData.roadsFingerprint === roadsFingerprint &&
          cacheData.configFingerprint === configFingerprint
          ? cacheData
          : null

        if (!cachedResult) {
          try {
            const localCache = localStorage.getItem(cacheKey)
            if (localCache) {
              const parsedCache: unknown = JSON.parse(localCache)
              if (
                isReachabilityCache(parsedCache) &&
                parsedCache.segmentCount === segmentCount &&
                parsedCache.roadsFingerprint === roadsFingerprint &&
                parsedCache.configFingerprint === configFingerprint
              ) cachedResult = parsedCache
            }
          } catch {
            try {
              localStorage.removeItem(cacheKey)
            } catch {
              // Browser storage can be disabled; the worker remains the fallback.
            }
          }
        }

        if (cachedResult) {
          setGreenDistances(cachedResult.distances)
          setCalculationProgress(cachedResult.segmentCount)
          setCalculationTotal(cachedResult.segmentCount)
          setRoadsReady(true)
          return
        }

        setRoadsReady(true)
        const worker = new Worker(new URL('./reachability.worker.ts', import.meta.url), { type: 'module' })
        workerRef.current = worker
        worker.onmessage = (message: MessageEvent<{ type: string; completed?: number; total?: number; distances?: number[]; quantiles?: number[] }>) => {
          if (message.data.type === 'progress') {
            setCalculationProgress(message.data.completed ?? 0)
            setCalculationTotal(message.data.total ?? 0)
          }
          if (message.data.type === 'complete') {
            const distances = message.data.distances ?? []
            const quantiles = message.data.quantiles ?? []
            setGreenDistances(distances)
            setCalculationProgress(message.data.total ?? 0)
            setCalculationTotal(message.data.total ?? 0)
            try {
              localStorage.setItem(cacheKey, JSON.stringify({
                version: 2,
                roadsFingerprint,
                configFingerprint,
                segmentCount,
                distances,
                quantiles,
              }))
            } catch {
              console.warn('Unable to save green-reachable distances to browser storage.')
            }
            worker.terminate()
            workerRef.current = null
          }
        }
        worker.onerror = (error) => {
          console.error('Unable to calculate green-reachable distances.', error)
          worker.terminate()
          workerRef.current = null
        }
        worker.postMessage({ roads, config })
      })
      .catch((error: unknown) => console.error('Unable to load Seattle OSM roads.', error))

    return () => {
      disposed = true
      workerRef.current?.terminate()
      workerRef.current = null
      mapContainer.removeEventListener('click', selectOrigin, true)
      map.remove()
      mapRef.current = null
      graphRef.current = null
      roadsRef.current = null
      riskConfigRef.current = null
      roadsFingerprintRef.current = null
      configFingerprintRef.current = null
      graphPromiseRef.current = null
      baseLayerRef.current = null
      reachabilityLayerRef.current = null
      comfortLayerRef.current?.remove()
      comfortLayerRef.current = null
      comfortBandLayersRef.current = new Map()
      originMarkerRef.current = null
    }
  }, [])

  useEffect(() => {
    if (mode !== 'comfort' || !roadsReady) return
    const roads = roadsRef.current
    const config = riskConfigRef.current
    const map = mapRef.current
    if (!roads || !config || !map) return

    if (!baseLayerRef.current) {
      baseLayerRef.current = L.geoJSON(roads as GeoJSON.GeoJsonObject, {
        interactive: false,
        style: { color: '#788680', opacity: 0.48, weight: 1.25, lineCap: 'round' },
      })
    }
    baseLayerRef.current.addTo(map)
    let cancelled = false

    if (!graphPromiseRef.current) {
      graphPromiseRef.current = (async () => {
        try {
          const response = await fetch(`${import.meta.env.BASE_URL}data/seattle-routing-graph.json`)
          if (response.ok) {
            const graphCache: unknown = await response.json()
            if (
              isRoutingGraphCache(graphCache) &&
              graphCache.roadsFingerprint === roadsFingerprintRef.current &&
              graphCache.configFingerprint === configFingerprintRef.current
            ) {
              const binaryResponse = await fetch(`${import.meta.env.BASE_URL}data/seattle-routing-graph.bin`)
              if (!binaryResponse.ok) throw new Error('Precomputed routing graph binary is unavailable')
              return restoreRoutingGraphBinary(graphCache, await binaryResponse.arrayBuffer(), config, roads)
            }
          }
        } catch {
          // Build from source roads when a matching precomputed graph is unavailable.
        }
        return buildRoutingGraph(roads, config)
      })()
    }

    graphPromiseRef.current.then((graph) => {
      if (cancelled) return
      graphRef.current = graph
    }).catch((error: unknown) => console.error('Unable to prepare the routing graph.', error))

    return () => {
      cancelled = true
    }
  }, [mode, roadsReady])

  useEffect(() => {
    const roads = roadsRef.current
    const map = mapRef.current
    if (!roads || !map || !roadsReady) return

    reachabilityLayerRef.current?.remove()
    reachabilityLayerRef.current = null
    if (mode !== 'comfort') comfortLayerRef.current?.remove()
    originMarkerRef.current?.remove()
    originMarkerRef.current = null

    if (mode === 'green-distance' && greenDistances) {
      baseLayerRef.current?.remove()
      const colors = reachabilityDisplay?.colors ?? []
      reachabilityLayerRef.current = L.geoJSON(
        createDistanceFeatures(roads, greenDistances),
        {
          interactive: false,
          style: (feature) => {
            const distance = feature?.properties?.distance as number ?? 0
            const band = reachabilityDisplay
              ? reachabilityDistanceBand(distance, reachabilityDisplay)
              : 0
            return {
              color: colors[band],
              opacity: 0.94,
              weight: 2.8,
              lineCap: 'round',
              lineJoin: 'round',
            }
          },
        },
      ).addTo(map)
    }
  }, [mode, roadsReady, greenDistances, reachabilityDisplay])

  const legendTicks = [1, 2, 5]
  const legendWidths = reachabilityDisplay
    ? [
        reachabilityDisplay.distanceBandsMiles[0],
        ...reachabilityDisplay.distanceBandsMiles.slice(1).map((miles, index) =>
          miles - reachabilityDisplay.distanceBandsMiles[index],
        ),
        reachabilityDisplay.legendMaxMiles - reachabilityDisplay.distanceBandsMiles[3],
      ]
    : []
  return (
    <main className="map-shell" aria-label="Seattle bicycle comfort map">
      <div className="map-canvas" ref={mapElement} />
      <div className="map-settings">
        <div className={`help-control${helpOpen ? ' is-open' : ''}`}>
          <button
            className="help-trigger"
            type="button"
            aria-label="More about the map"
            aria-expanded={helpOpen}
            aria-describedby="map-help-copy"
            title="More about the map"
            onClick={() => setHelpOpen((open) => !open)}
          >
            ?
          </button>
          <section className="help-popover" id="map-help-copy" aria-label="About this map">
            <p>{reachabilityDisplay?.helpText}</p>
          </section>
        </div>
        <button
          className="settings-trigger"
          type="button"
          aria-label="Map settings"
          aria-expanded={settingsOpen}
          title="Map settings"
          onClick={() => setSettingsOpen((open) => !open)}
        >
          <span aria-hidden="true">⚙</span>
        </button>
        {settingsOpen && (
          <section className="settings-menu" aria-label="Map settings">
            <h1>Map view</h1>
            <div className="view-options" role="group" aria-label="Choose map view">
              <button
                type="button"
                aria-pressed={mode === 'green-distance'}
                onClick={() => changeMode('green-distance')}
              >
                Reachable distance
              </button>
              <button
                type="button"
                aria-pressed={mode === 'comfort'}
                onClick={() => changeMode('comfort')}
              >
                Click to view comfort
              </button>
            </div>
          </section>
        )}
      </div>
      {mode === 'green-distance' && (
        <aside className="distance-legend" aria-label="Green-reachable distance legend">
          <div className="legend-heading">{reachabilityDisplay?.title ?? 'Safe bikeable distance'}</div>
          <div className="legend-copy">{reachabilityDisplay?.subtitle}</div>
          {greenDistances && reachabilityDisplay ? (
            <div className="legend-scale">
              <div
                className="legend-swatches"
                style={{ gridTemplateColumns: legendWidths.map((width) => `${width}fr`).join(' ') }}
              >
                {reachabilityDisplay.colors.map((color) => (
                  <span key={color} style={{ backgroundColor: color }} />
                ))}
              </div>
              <div className="legend-values">
                <span>0</span>
                {legendTicks.map((miles) => (
                  <span
                    key={miles}
                    style={{ left: `${miles / reachabilityDisplay.legendMaxMiles * 100}%` }}
                  >
                    {miles === 5 ? '5+ mi' : miles}
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <div className="legend-progress" role="status">
              {calculationTotal > 0
                ? `Calculating ${Math.round(calculationProgress / calculationTotal * 100)}%`
                : 'Preparing road network'}
            </div>
          )}
        </aside>
      )}
    </main>
  )
}

export default App
