import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildRoutingGraph,
  calculateGreenReachableDistance,
  validateRiskConfig,
} from '../src/routing.ts'
import {
  createRoutingGraphCache,
  encodeRoutingGraph,
  fingerprint,
  reachabilityConfigFingerprint,
} from '../src/reachability-cache.ts'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [roads, rawConfig] = await Promise.all([
  readFile(resolve(projectRoot, 'public/data/seattle-highways.geojson'), 'utf8').then(JSON.parse),
  readFile(resolve(projectRoot, 'public/config.json'), 'utf8').then(JSON.parse),
])
const config = validateRiskConfig(rawConfig)
const graph = buildRoutingGraph(roads, config)
const distances = new Array(graph.segments.length)
const startedAt = Date.now()

for (let index = 0; index < graph.segments.length; index += 1) {
  distances[index] = calculateGreenReachableDistance(graph, graph.segments[index])
  if ((index + 1) % 1000 === 0 || index + 1 === graph.segments.length) {
    const percent = Math.round((index + 1) / graph.segments.length * 100)
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000)
    console.log(`${index + 1}/${graph.segments.length} segments (${percent}%), ${elapsedSeconds}s elapsed`)
  }
}

const sorted = [...distances].sort((left, right) => left - right)
const quantiles = [0.2, 0.4, 0.6, 0.8, 1].map((fraction) =>
  sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0,
)
const cache = {
  version: 2,
  roadsFingerprint: fingerprint(roads),
  configFingerprint: reachabilityConfigFingerprint(config),
  segmentCount: graph.segments.length,
  distances,
  quantiles,
}
const outputPath = resolve(projectRoot, 'public/data/seattle-reachability.json')
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, JSON.stringify(cache))
console.log(`Saved cached reachability for ${graph.segments.length} segments to public/data/seattle-reachability.json.`)

const graphCache = createRoutingGraphCache(graph, cache.roadsFingerprint, cache.configFingerprint)
const graphOutputPath = resolve(projectRoot, 'public/data/seattle-routing-graph.json')
await writeFile(graphOutputPath, JSON.stringify(graphCache))
await writeFile(resolve(projectRoot, 'public/data/seattle-routing-graph.bin'), encodeRoutingGraph(graph))
console.log(`Saved routing graph for ${graph.segments.length} segments to public/data/seattle-routing-graph.json.`)