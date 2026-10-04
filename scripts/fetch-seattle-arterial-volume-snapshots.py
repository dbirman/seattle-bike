#!/usr/bin/env python3
"""Download Seattle's public yearly arterial-volume feature layers."""

from __future__ import annotations

import argparse
import gzip
import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
GROUP_ITEM_ID = "cc17c23f13ca4fe2948b008a9846404d"
GROUP_DATA_URL = f"https://www.arcgis.com/sharing/rest/content/items/{GROUP_ITEM_ID}/data?f=json"
OUTPUT = ROOT / "data" / "seattle-traffic" / "source" / "arterial-volume-snapshots"


def get_json(url: str) -> dict:
    request = Request(
        url,
        headers={"Accept": "application/json", "User-Agent": "seattle-bike-traffic-data/1.0"},
    )
    with urlopen(request, timeout=180) as response:
        return json.load(response)


def request_json(url: str, params: dict[str, str]) -> dict:
    full_url = f"{url}?{urlencode(params)}"
    last_error: Exception | None = None
    for attempt in range(1, 4):
        try:
            return get_json(full_url)
        except (HTTPError, URLError, TimeoutError, OSError, json.JSONDecodeError) as error:
            last_error = error
            if attempt < 3:
                time.sleep(2**attempt)
    raise RuntimeError(f"Seattle ArcGIS request failed: {last_error}")


def download_layer(year: str, title: str, layer_url: str, output: Path) -> tuple[str, int, int]:
    metadata = get_json(f"{layer_url}?f=json")
    if "error" in metadata:
        raise RuntimeError(f"{year}: {metadata['error']}")
    oid_field = metadata.get("objectIdField") or metadata.get("objectIdFieldName")
    if not oid_field:
        oid_field = next(
            (field["name"] for field in metadata["fields"] if field["type"] == "esriFieldTypeOID"),
            None,
        )
    if not oid_field:
        raise RuntimeError(f"{year}: no object ID field in layer metadata")
    expected_response = request_json(
        f"{layer_url}/query", {"where": "1=1", "returnCountOnly": "true", "f": "json"}
    )
    if "error" in expected_response:
        raise RuntimeError(f"{year}: {expected_response['error']}")
    expected = int(expected_response["count"])
    fields = [field["name"] for field in metadata["fields"] if field["type"] != "esriFieldTypeBlob"]
    page_size = min(int(metadata.get("maxRecordCount", 2000)), 2000)
    target = output / f"year={year}.featureset.json.gz"
    partial = target.with_suffix(target.suffix + ".part")
    total = 0
    try:
        with gzip.open(partial, "wt", encoding="utf-8") as stream:
            stream.write("{\"geometryType\":")
            json.dump(metadata.get("geometryType"), stream)
            stream.write(",\"spatialReference\":{\"wkid\":4326},\"fields\":")
            json.dump([field for field in metadata["fields"] if field["type"] != "esriFieldTypeBlob"], stream)
            stream.write(",\"features\":[")
            first = True
            for offset in range(0, expected, page_size):
                page = request_json(
                    f"{layer_url}/query",
                    {
                        "where": "1=1",
                        "outFields": ",".join(fields),
                        "returnGeometry": "true",
                        "outSR": "4326",
                        "orderByFields": oid_field,
                        "resultOffset": str(offset),
                        "resultRecordCount": str(page_size),
                        "f": "json",
                    },
                )
                if "error" in page:
                    raise RuntimeError(f"{year}: {page['error']}")
                features = page.get("features", [])
                if not features and offset < expected:
                    raise RuntimeError(f"{year}: no features returned at offset {offset:,}")
                for feature in features:
                    if not first:
                        stream.write(",")
                    json.dump(feature, stream, separators=(",", ":"))
                    first = False
                total += len(features)
                print(f"{title}: {total:,}/{expected:,} features", flush=True)
            stream.write("]}")
        if total != expected:
            raise RuntimeError(f"{year}: expected {expected:,} features, received {total:,}")
        partial.replace(target)
    except Exception:
        partial.unlink(missing_ok=True)
        raise
    return year, total, target.stat().st_size


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)

    group = get_json(GROUP_DATA_URL)
    layers = []
    for layer in group.get("layers", []):
        year_match = re.search(r"\b(20\d{2})\b", layer.get("title", ""))
        if year_match and layer.get("url"):
            layers.append((year_match.group(1), layer["title"], layer["url"]))
    if not layers:
        raise RuntimeError("No yearly Seattle arterial-volume layers found in the public group layer")

    results = [download_layer(*layer, output) for layer in sorted(layers)]
    manifest = {
        "downloaded_at_utc": datetime.now(timezone.utc).isoformat(),
        "group_layer": GROUP_DATA_URL,
        "years": {
            year: {"title": next(title for y, title, _ in layers if y == year), "rows": rows}
            for year, rows, _ in results
        },
        "total_rows": sum(rows for _, rows, _ in results),
        "compressed_bytes": sum(size for _, _, size in results),
    }
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
