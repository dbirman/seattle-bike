import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clipLine } from './geojson-clip.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const seattleBounds = { south: 47.49, west: -122.45, north: 47.75, east: -122.22 }
const fremontBounds = { south: 47.648, west: -122.387, north: 47.672, east: -122.357 }
const overpassUrl = 'https://overpass-api.de/api/interpreter'
const bbox = `${seattleBounds.south},${seattleBounds.west},${seattleBounds.north},${seattleBounds.east}`
const query = `[out:json][timeout:240];(way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|service|road|cycleway)"](${bbox});way["highway"~"^(path|track|footway|pedestrian)$"]["bicycle"~"^(yes|designated|permissive)$"](${bbox}););out geom;`

const requestUrl = new URL(overpassUrl)
requestUrl.searchParams.set('data', query)
const response = await fetch(requestUrl, {
  headers: { accept: 'application/json', 'user-agent': 'seattle-bike-data-builder/1.0' },
})
if (!response.ok) throw new Error(`Overpass returned HTTP ${response.status}`)
const payload = await response.json()
if (payload.remark) throw new Error(`Overpass error: ${payload.remark}`)

const seattleFeatures = []
const fremontFeatures = []
const cityFeatures = []
for (const way of payload.elements) {
  if (way.type !== 'way' || !way.geometry || way.geometry.length < 2) continue
  if (way.tags.access === 'no' || way.tags.bicycle === 'no') continue
  if (way.tags.service === 'driveway' && way.tags.bicycle !== 'yes') continue
  if (way.tags.highway.startsWith('motorway') && way.tags.bicycle !== 'yes') continue
  const coordinates = way.geometry.map(({ lon, lat }) => [lon, lat])
  const properties = { ...way.tags, osm_id: way.id }
  seattleFeatures.push({
    type: 'Feature',
    id: `way/${way.id}`,
    properties,
    geometry: { type: 'LineString', coordinates },
  })

  for (const [partIndex, part] of clipLine(coordinates, seattleBounds).entries()) {
    cityFeatures.push({
      type: 'Feature',
      id: `way/${way.id}/city-${partIndex}`,
      properties,
      geometry: { type: 'LineString', coordinates: part },
    })
  }

  for (const part of clipLine(coordinates, fremontBounds)) {
    fremontFeatures.push({
      type: 'Feature',
      id: `way/${way.id}/${fremontFeatures.length}`,
      properties,
      geometry: { type: 'LineString', coordinates: part },
    })
  }
}

if (!seattleFeatures.length || !fremontFeatures.length) {
  throw new Error(`Expected Seattle and Fremont roads; received ${seattleFeatures.length} and ${fremontFeatures.length}`)
}

const writeGeoJson = async (path, features) => {
  const output = resolve(projectRoot, path)
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify({ type: 'FeatureCollection', features }))
}

await writeGeoJson('data/osm/seattle-highways.geojson', seattleFeatures)
await writeGeoJson('public/data/seattle-highways.geojson', cityFeatures)
await writeGeoJson('public/data/fremont-highways.geojson', fremontFeatures)
console.log(`Saved ${seattleFeatures.length} Seattle-area ways, ${cityFeatures.length} city features, and ${fremontFeatures.length} Fremont line segments.`)
