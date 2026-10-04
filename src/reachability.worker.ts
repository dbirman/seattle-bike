import {
  buildRoutingGraph,
  calculateGreenReachableDistance,
  type RoadCollection,
  type RiskConfig,
} from './routing'

interface CalculateMessage {
  roads: RoadCollection
  config: RiskConfig
}

self.onmessage = (event: MessageEvent<CalculateMessage>) => {
  const graph = buildRoutingGraph(event.data.roads, event.data.config)
  const distances: number[] = []
  const total = graph.segments.length
  let index = 0

  const calculateBatch = () => {
    const batchEnd = Math.min(index + 32, total)
    for (; index < batchEnd; index += 1) {
      distances.push(calculateGreenReachableDistance(graph, graph.segments[index]))
    }
    self.postMessage({ type: 'progress', completed: index, total })
    if (index < total) {
      setTimeout(calculateBatch, 0)
      return
    }

    const sorted = [...distances].sort((left, right) => left - right)
    const quantiles = [0.2, 0.4, 0.6, 0.8, 1].map((fraction) =>
      sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0,
    )
    self.postMessage({ type: 'complete', distances, quantiles })
  }

  calculateBatch()
}
