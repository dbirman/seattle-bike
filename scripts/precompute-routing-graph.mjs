import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildRoutingGraph, validateRiskConfig } from '../src/routing.ts'
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
const cache = createRoutingGraphCache(
  graph,
  fingerprint(roads),
  reachabilityConfigFingerprint(config),
)
const outputPath = resolve(projectRoot, 'public/data/seattle-routing-graph.json')
await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, JSON.stringify(cache))
await writeFile(resolve(projectRoot, 'public/data/seattle-routing-graph.bin'), encodeRoutingGraph(graph))
console.log(`Saved routing graph for ${graph.segments.length} segments to public/data/seattle-routing-graph.json.`)