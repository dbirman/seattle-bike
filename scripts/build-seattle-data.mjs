import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clipLine } from './geojson-clip.mjs'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bounds = { south: 47.49, west: -122.45, north: 47.75, east: -122.22 }
const sourcePath = resolve(projectRoot, 'data/osm/seattle-highways.geojson')
const source = JSON.parse(await readFile(sourcePath, 'utf8'))
const features = []

for (const feature of source.features) {
  for (const [partIndex, coordinates] of clipLine(feature.geometry.coordinates, bounds).entries()) {
    features.push({
      ...feature,
      id: `${feature.id}/city-${partIndex}`,
      geometry: { ...feature.geometry, coordinates },
    })
  }
}

if (features.length === 0) throw new Error('No roads intersect the configured Seattle rectangle')

const outputPath = resolve(projectRoot, 'public/data/seattle-highways.geojson')
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, JSON.stringify({ type: 'FeatureCollection', features }))
const segmentCount = features.reduce((count, feature) => count + feature.geometry.coordinates.length - 1, 0)
console.log(`Saved ${features.length} city road features and ${segmentCount} segments to public/data/seattle-highways.geojson.`)