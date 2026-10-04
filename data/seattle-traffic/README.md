# Seattle traffic-count research

Downloaded from Seattle's public Socrata API on 2026-09-26. The main comfort-map display is unchanged; the standalone preview is at `/traffic-volume.html`.

## Source and API

SDOT's [Traffic Volume and Crash Data page](https://www.seattle.gov/transportation/permits-and-services/interactive-maps/traffic-volume-and-crash-data) links to its road-segment-count dashboard and says those counts cover 2000-present. The related public dataset is **Traffic Counts by Study**, dataset ID `xucb-vzhc`, on Seattle's Socrata domain [`cos-data.seattle.gov`](https://cos-data.seattle.gov/Transportation/Traffic-Counts-by-Study/xucb-vzhc). Seattle's catalog description says this table contains each study's location and summary statistics, with 15-minute and hourly bins in related tables.

Bulk download:

```sh
curl -L 'https://cos-data.seattle.gov/api/v3/views/xucb-vzhc/export.csv?accessType=DOWNLOAD' \
  -o traffic-counts-by-study.csv
```

The public export worked without an app token. For smaller queries, Socrata's resource endpoint supports SoQL, for example:

```text
https://cos-data.seattle.gov/resource/xucb-vzhc.json?$select=study_id,compkey,start_date,adt,awdt&$where=compkey%20is%20not%20null&$order=start_date%20DESC&$limit=1000
```

Schema snapshots for the `xucb-vzhc`, `s72h-pqjm`, `g32r-fjzp`, and `gi49-5uh6` tables are saved here. Large source exports and derived Parquet tables are excluded from Git; they are local research inputs and are not required to build the web app, which uses the generated assets under `public/data/`.

## What the data contains

- The by-study export has 64,317 study records and 31 fields. The key fields are `STUDY_ID`, Seattle street-network `COMPKEY`, `START_DATE`, `END_DATE`, `ACTUAL_DAYS`, `LANE_DESIGNATION_CODE_ID`, `TRAFFIC_FLOW_DIR_ID`, `ADT`, and `AWDT`.
- 51,533 records are tagged `VOLUME COUNT`; 50,946 of those have a `COMPKEY`, covering 6,662 distinct street-network keys over the full history. `COMPKEY` is a Seattle street-segment key, not an OSM ID, and the CSV has no geometry.
- The records span 1990–2026; almost all begin in 2000 or later. Of the `VOLUME COUNT` records, 1,487 start in 2024, 1,489 in 2025, and 1,139 in 2026. Together, those three years touch 1,555 distinct `COMPKEY`s. There are 987 distinct keys with a 2025 or 2026 volume-count record.
- Most studies cover seven days (`ACTUAL_DAYS=7` on 62,343 of 64,317 records). The type lookup has multiple type rows per study, so collapse it to one study-to-type set before joining.
- Among `VOLUME COUNT` study rows, `AWDT` has a median of about 6,297 and a mean of about 9,483 vehicles/day. Those are repeated, directional study records, not independent road-segment averages; first choose the latest usable total per `COMPKEY` before estimating class baselines. Seattle's [2023 traffic report](https://www.seattle.gov/documents/Departments/SDOT/About/DocumentLibrary/Reports/2023_Traffic_Report.pdf) describes the AWDT on its arterial flow maps as a Monday–Friday, 24-hour average.
- In the whole by-study export, `ADT` is zero on 2,738 records and `AWDT` on 66; among `VOLUME COUNT` records, those counts are 1,983 and 31. Treat zero as a value to investigate, not automatically as a real zero-traffic street.
- `TRAFFIC_FLOW_DIR_ID=11` means a total assembled from multiple directions. Most study records are directional, and studies may also repeat a location over time. Use the documented total where available; otherwise resolve paired directions and study dates before combining. Do not sum the history or all rows for a `COMPKEY`.
- The CSV export formats numeric IDs with thousands separators (for example, `STUDY_ID` `351,486` and `COMPKEY` `22,804`), while the type lookup may emit those IDs without separators. Strip grouping commas before joining.

## Implications for the routing model

The records are repeated measurements, not one current value per segment. For a first ratio weighting, use a recent usable `AWDT` (weekday) or `ADT` (all days) for each `COMPKEY`, then compare against a road-class baseline. Older studies should not be averaged together as if they were current traffic.

Join `COMPKEY` through Seattle's Street Network Database before aligning with the OSM network. For uncovered roads, use bounded, road-network-aware interpolation among connected nearby streets with similar OSM classification and lane/speed context. A straight-line nearest-measurement fill can incorrectly transfer a busy road's volume to a parallel local street. Keep measurement age and source study type so direct observations remain distinguishable from estimates.

For a per-class multiplier, use a robust baseline such as the class median (or a trimmed mean), shrink sparse observations toward that baseline, and cap the multiplier range. Traffic volume distributions are skewed, and an uncapped ratio can let a few high-volume segments dominate the score.

## 2023 map preview and COMPKEY join

The minimal preview at `/traffic-volume.html` uses 2023 records tagged `FLOWMAP ELEMENT` from the public [Traffic Counts by Study](https://catalog.data.gov/dataset/traffic-counts-by-study) table. That table is downloadable without an ArcGIS login. Seattle's [2024 traffic report](https://www.seattle.gov/documents/Departments/SDOT/About/DocumentLibrary/Reports/2024_Traffic_Report.pdf) defines the 2023 AAWDT map as seasonally adjusted Monday–Friday, 24-hour volumes.

Street geometry comes from the public [Seattle Streets](https://catalog.data.gov/dataset/seattle-streets) GeoJSON export. This layer comes from Seattle's Street Network Database and carries `COMPKEY`, the same key used by Traffic Counts by Study. Seattle's metadata defines `COMPKEY` as the primary key of a street asset, and its Socrata field description says the key links a count to a street segment for georeferencing. A direct key join matched all 560 distinct COMPKEYs in the 2023 volume-count records. No geocoding, ArcGIS account, or OSM-ID lookup is needed to place these records on Seattle street geometry. The generated preview data is saved as `public/data/seattle-traffic-flow-2023.geojson`.

The 2023 flow-map subset has 250 study rows on 246 street segments. For segments with total-flow records (`TRAFFIC_FLOW_DIR_ID=11`), the preview uses the median AWDT among those rows. For 44 one-way segments with no total row, it uses the median observed direction. Three two-way segments have only one observed direction, so their popups flag that the total is incomplete. The annual flow-map subset covers arterial classes only; the broader 2023 study table includes 49 non-arterial segments among its 560 measured COMPKEYs.


## Full count-history package

The public Socrata tables were refreshed on 2026-09-26. The source exports contain 64,317 study rows (`xucb-vzhc`), 90,533 study-type rows (`s72h-pqjm`), 450,184 hourly rows (`g32r-fjzp`), and 43,200,192 15-minute rows (`gi49-5uh6`). The public Seattle ArcGIS study layer adds 62,681 georeferenced records. All 62,681 layer study IDs are present in the Socrata study table; 1,636 Socrata studies are absent from the layer. Seattle's [Traffic Counts by Study](https://catalog.data.gov/dataset/traffic-counts-by-study) catalog entry describes the study summary and related time-bin tables.

Seattle also publishes annual arterial-volume line layers. The current [Arterial Traffic Volumes - Yearly group](https://www.arcgis.com/sharing/rest/content/items/cc17c23f13ca4fe2948b008a9846404d/data?f=json) contains snapshots for 2015–2024, totaling 19,601 segment records. These arterial-only snapshots are preserved separately by year because they are preprocessed annual values rather than individual study observations. Their line geometry is present on every row, but `COMPKEY` is populated on only 6,470 rows; it is blank for all 2015–2016 records and many later records.

Source files:

- `traffic-counts-by-study.csv` and `traffic-count-study-types.csv` are the refreshed complete summary and lookup exports.
- `source/hourly-counts.csv.gz` contains the complete hourly table.
- `source/quarter-hour-counts-by-year/count_year=YYYY.csv.gz` contains the complete 15-minute table split by measurement year. The downloader compares every year's row count with the API before keeping the file.
- `source/traffic-studies-featureset.json.gz` is the public [Seattle ArcGIS Traffic Studies layer](https://services.arcgis.com/ZOyb2t4B0UYuYNYH/arcgis/rest/services/Traffic_Studies/FeatureServer/0), including the `FLOWMAP` flag and point geometry. It has a `SEG_COMPKEY` for every record; 523 records have no point coordinate.
- `source/arterial-volume-snapshots/year=YYYY.featureset.json.gz` contains the yearly line layers for 2015–2024 from the public ArcGIS group.

Typed Parquet outputs are in `parquet/`:

- `studies.parquet`: one row per study, with `study_types`, `study_year`, and `is_volume_count` fields.
- `study_types.parquet`: normalized study-to-type links.
- `volume_observations.parquet`: all study rows tagged `VOLUME COUNT`, including rows without a `COMPKEY`.
- `hourly_counts.parquet`: hourly/day summary rows joined to `COMPKEY`, study year, direction, and the volume-count flag.
- `quarter_hour_counts/count_year=YYYY/part-00000.parquet`: 15-minute rows joined to `COMPKEY`, direction, study year, and the volume-count flag. `count_year` is the Hive partition key.
- `arcgis_traffic_studies.parquet`: all 62,681 ArcGIS records, with source fields, `compkey` (copied from `seg_compkey`), `longitude`, `latitude`, `is_volume_count`, and `is_flowmap`. The `FLOWMAP=Y` subset has 6,785 records across the study history.
- `annual_arterial_volumes.parquet`: all 19,601 annual line-layer records, with `snapshot_year`, canonical `compkey`, `aadt`, `awdt`, and `awdt_rounded` columns, source quality/adjustment fields, and line geometry encoded as JSON text.
- `manifest.json`: source URLs and packaged row counts.

To refresh the 15-minute history, traffic-study point layer, or annual line snapshots, run `python3 scripts/fetch-seattle-traffic-intervals.py`, `python3 scripts/fetch-seattle-traffic-studies-arcgis.py`, or `python3 scripts/fetch-seattle-arterial-volume-snapshots.py`, respectively. Refresh the summary/type/hourly source exports from their Socrata CSV URLs before packaging. The packager requires `pandas` and `pyarrow`. A typical PyArrow read is:

```python
import pyarrow.dataset as ds

intervals = ds.dataset(
    "data/seattle-traffic/parquet/quarter_hour_counts",
    format="parquet",
    partitioning="hive",
)
```
