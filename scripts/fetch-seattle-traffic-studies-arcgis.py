#!/usr/bin/env python3
"""Download Seattle's public traffic-study point layer as a gzipped FeatureSet."""

from __future__ import annotations

import argparse
import gzip
import json
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
LAYER_URL = (
    "https://services.arcgis.com/ZOyb2t4B0UYuYNYH/arcgis/rest/services/"
    "Traffic_Studies/FeatureServer/0"
)
DEFAULT_OUTPUT = ROOT / "data" / "seattle-traffic" / "source" / "traffic-studies-featureset.json.gz"
PAGE_SIZE = 2000


def get_json(url: str) -> dict:
    request = Request(
        url,
        headers={"Accept": "application/json", "User-Agent": "seattle-bike-traffic-data/1.0"},
    )
    with urlopen(request, timeout=180) as response:
        return json.load(response)


def request_json(params: dict[str, str]) -> dict:
    url = f"{LAYER_URL}/query?{urlencode(params)}"
    last_error: Exception | None = None
    for attempt in range(1, 4):
        try:
            return get_json(url)
        except (HTTPError, URLError, TimeoutError, OSError, json.JSONDecodeError) as error:
            last_error = error
            if attempt < 3:
                time.sleep(2**attempt)
    raise RuntimeError(f"Seattle ArcGIS request failed: {last_error}")


def download(output: Path) -> int:
    metadata = get_json(f"{LAYER_URL}?f=json")
    if "error" in metadata:
        raise RuntimeError(metadata["error"])
    fields = [field["name"] for field in metadata["fields"] if field["type"] != "esriFieldTypeBlob"]

    count_response = request_json(
        {"where": "1=1", "returnCountOnly": "true", "f": "json"}
    )
    if "error" in count_response:
        raise RuntimeError(count_response["error"])
    expected = int(count_response["count"])

    output.parent.mkdir(parents=True, exist_ok=True)
    partial = output.with_suffix(output.suffix + ".part")
    total = 0
    try:
        with gzip.open(partial, "wt", encoding="utf-8") as stream:
            stream.write("{\"geometryType\":\"esriGeometryPoint\",\"spatialReference\":{\"wkid\":4326},")
            stream.write("\"fields\":")
            json.dump([field for field in metadata["fields"] if field["type"] != "esriFieldTypeBlob"], stream)
            stream.write(",\"features\":[")
            first = True
            for offset in range(0, expected, PAGE_SIZE):
                page = request_json(
                    {
                        "where": "1=1",
                        "outFields": ",".join(fields),
                        "returnGeometry": "true",
                        "outSR": "4326",
                        "orderByFields": "OBJECTID",
                        "resultOffset": str(offset),
                        "resultRecordCount": str(PAGE_SIZE),
                        "f": "json",
                    }
                )
                if "error" in page:
                    raise RuntimeError(page["error"])
                features = page.get("features", [])
                if not features and offset < expected:
                    raise RuntimeError(f"ArcGIS returned no features at offset {offset:,}")
                for feature in features:
                    if not first:
                        stream.write(",")
                    json.dump(feature, stream, separators=(",", ":"))
                    first = False
                total += len(features)
                print(f"Fetched {total:,}/{expected:,} features", flush=True)
            stream.write("]}")

        if total != expected:
            raise RuntimeError(f"Expected {expected:,} features, received {total:,}")
        partial.replace(output)
    except Exception:
        partial.unlink(missing_ok=True)
        raise
    return total


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    total = download(args.output.resolve())
    print(
        json.dumps(
            {
                "downloaded_at_utc": datetime.now(timezone.utc).isoformat(),
                "layer": LAYER_URL,
                "features": total,
                "output": str(args.output.resolve()),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
