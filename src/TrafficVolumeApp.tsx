import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import './TrafficVolumeApp.css'

type TrafficMeasurement = {
  studyId: string
  date: string
  direction: string
  awdt: number
  used: boolean
}

type TrafficProperties = {
  compkey: number
  street: string
  arterialClass: string
  aawdt: number
  method: 'two_way_total' | 'one_way_direction' | 'direction_only'
  directions: string
  measurements: TrafficMeasurement[]
}

type TrafficGeometry = GeoJSON.LineString | GeoJSON.MultiLineString
type TrafficCollection = GeoJSON.FeatureCollection<TrafficGeometry, TrafficProperties>

const volumeBands = [
  { color: '#238b65', label: '< 1,000', max: 1_000 },
  { color: '#91aa48', label: '1,000–4,999', max: 5_000 },
  { color: '#e0b43b', label: '5,000–9,999', max: 10_000 },
  { color: '#e57d32', label: '10,000–19,999', max: 20_000 },
  { color: '#d44b45', label: '20,000+', max: Infinity },
]

function colorForVolume(volume: number): string {
  return volumeBands.find((band) => volume < band.max)?.color ?? volumeBands.at(-1)!.color
}

function formatVolume(volume: number): string {
  return `${Math.round(volume).toLocaleString()} vehicles/day`
}

function popupFor(properties: TrafficProperties): HTMLElement {
  const root = document.createElement('div')
  root.className = 'volume-popup'

  const title = document.createElement('strong')
  title.textContent = properties.street || `COMPKEY ${properties.compkey}`
  root.append(title)

  const volume = document.createElement('p')
  volume.textContent = `${formatVolume(properties.aawdt)} · ${properties.arterialClass}`
  root.append(volume)

  const note = document.createElement('p')
  note.textContent = properties.method === 'two_way_total'
    ? 'Two-way total from SDOT'
    : properties.method === 'one_way_direction'
      ? `One-way street · ${properties.directions} count`
      : `One direction only (${properties.directions}) · two-way total unavailable`
  root.append(note)

  const list = document.createElement('ul')
  for (const measurement of properties.measurements) {
    const item = document.createElement('li')
    item.textContent = `${measurement.date} · ${measurement.direction} · ${formatVolume(measurement.awdt)}${measurement.used ? ' (used)' : ''}`
    list.append(item)
  }
  root.append(list)

  return root
}

function TrafficVolumeApp() {
  const mapElement = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState('Loading 2023 counts…')

  useEffect(() => {
    if (!mapElement.current) return

    const map = L.map(mapElement.current, { zoomControl: true }).setView([47.61, -122.33], 11)
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
    }).addTo(map)

    let cancelled = false
    fetch(`${import.meta.env.BASE_URL}data/seattle-traffic-flow-2023.geojson`)
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json() as Promise<TrafficCollection>
      })
      .then((data) => {
        if (cancelled) return
        const layer = L.geoJSON(data, {
          style: (feature) => ({
            color: colorForVolume(Number(feature?.properties?.aawdt ?? 0)),
            opacity: 0.92,
            weight: 4,
            lineCap: 'round',
            lineJoin: 'round',
          }),
          onEachFeature: (feature, featureLayer) => {
            if (feature.properties) featureLayer.bindPopup(popupFor(feature.properties as TrafficProperties))
          },
        }).addTo(map)
        const bounds = layer.getBounds()
        if (bounds.isValid()) map.fitBounds(bounds.pad(0.06), { maxZoom: 13 })
        setStatus(`${data.features.length} measured street segments`)
      })
      .catch(() => {
        if (!cancelled) setStatus('Could not load the bundled traffic data.')
      })

    return () => {
      cancelled = true
      map.remove()
    }
  }, [])

  return (
    <main className="traffic-demo">
      <header className="traffic-header">
        <div>
          <h1>Seattle traffic volumes · 2023</h1>
          <p>Seasonally adjusted weekday motor-vehicle volume (AAWDT). Click a line for its count.</p>
        </div>
        <div className="traffic-count">{status}</div>
      </header>
      <section className="traffic-map" aria-label="Map of Seattle traffic volumes">
        <div className="traffic-map-canvas" ref={mapElement} />
        <aside className="volume-legend" aria-label="Daily traffic volume legend">
          <strong>Vehicles per weekday</strong>
          {volumeBands.map((band) => (
            <div className="volume-legend-row" key={band.label}>
              <i style={{ backgroundColor: band.color }} />
              <span>{band.label}</span>
            </div>
          ))}
          <p>Arterial flow-map segments only. Counts are total motor vehicles; no car/truck split.</p>
        </aside>
        <div className="traffic-credit">
          <a href="https://catalog.data.gov/dataset/traffic-counts-by-study" target="_blank" rel="noreferrer">SDOT counts</a>
          {' · '}
          <a href="https://catalog.data.gov/dataset/seattle-streets" target="_blank" rel="noreferrer">Seattle Streets</a>
        </div>
      </section>
    </main>
  )
}

export default TrafficVolumeApp
