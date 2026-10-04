#!/usr/bin/env python3
"""Download the full 15-minute Seattle traffic-count table by measurement year."""

from __future__ import annotations

import argparse
import gzip
import json
import shutil
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "data" / "seattle-traffic" / "source" / "quarter-hour-counts-by-year"
DOMAIN = "https://cos-data.seattle.gov"
VIEW_ID = "gi49-5uh6"
INTERVAL_URL = f"{DOMAIN}/resource/{VIEW_ID}.csv"
COUNT_QUERY_URL = f"{DOMAIN}/resource/{VIEW_ID}.json"
LIMIT = 5_000_000


def request(url: str):
    headers = {
        "Accept": "text/csv",
        "Accept-Encoding": "gzip",
        "User-Agent": "seattle-bike-traffic-data/1.0",
    }
    return urlopen(Request(url, headers=headers), timeout=1800)


def fetch_expected_counts() -> dict[str, int]:
    query = {
        "$select": "count_year,count(*) as row_count",
        "$group": "count_year",
        "$order": "count_year",
    }
    url = f"{COUNT_QUERY_URL}?{urlencode(query)}"
    with urlopen(Request(url, headers={"Accept": "application/json"}), timeout=120) as response:
        records = json.load(response)
    return {str(record["count_year"]): int(record["row_count"]) for record in records}


def newline_count(path: Path) -> int:
    total = 0
    with gzip.open(path, "rb") as stream:
        while chunk := stream.read(8 * 1024 * 1024):
            total += chunk.count(b"\n")
    return max(0, total - 1)


def download_year(year: str, expected: int) -> tuple[str, int, int]:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    target = OUTPUT / f"count_year={year}.csv.gz"
    if target.exists() and newline_count(target) == expected:
        return year, expected, target.stat().st_size

    params = {
        "$where": f"count_year = {year}",
        "$order": "count_id",
        "$limit": str(LIMIT),
    }
    url = f"{INTERVAL_URL}?{urlencode(params)}"
    partial = target.with_suffix(target.suffix + ".part")
    last_error: Exception | None = None
    for attempt in range(1, 4):
        try:
            partial.unlink(missing_ok=True)
            with request(url) as response, partial.open("wb") as raw_file:
                if response.headers.get("Content-Encoding") == "gzip":
                    shutil.copyfileobj(response, raw_file, length=8 * 1024 * 1024)
                else:
                    with gzip.GzipFile(fileobj=raw_file, mode="wb", compresslevel=1) as compressed:
                        shutil.copyfileobj(response, compressed, length=8 * 1024 * 1024)
            actual = newline_count(partial)
            if actual != expected:
                raise RuntimeError(f"{year}: expected {expected:,} records, got {actual:,}")
            partial.replace(target)
            return year, actual, target.stat().st_size
        except (HTTPError, URLError, TimeoutError, OSError, RuntimeError) as error:
            last_error = error
            partial.unlink(missing_ok=True)
            if attempt < 3:
                time.sleep(2**attempt)
    raise RuntimeError(f"Download failed for {year}: {last_error}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workers", type=int, default=2)
    args = parser.parse_args()

    expected = fetch_expected_counts()
    results: list[tuple[str, int, int]] = []
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        jobs = {pool.submit(download_year, year, count): year for year, count in expected.items()}
        for job in as_completed(jobs):
            result = job.result()
            results.append(result)
            print(f"{result[0]}: {result[1]:,} rows, {result[2] / 1024 / 1024:.1f} MiB compressed")

    totals = {
        "years": len(results),
        "rows": sum(rows for _, rows, _ in results),
        "compressed_bytes": sum(size for _, _, size in results),
    }
    (OUTPUT / "manifest.json").write_text(
        json.dumps(
            {
                "dataset_id": VIEW_ID,
                "api": INTERVAL_URL,
                "http_compression": "gzip when available",
                "rows_by_count_year": dict(sorted((year, rows) for year, rows, _ in results)),
                "totals": totals,
            },
            indent=2,
        )
        + "\n"
    )
    print(json.dumps(totals, indent=2))


if __name__ == "__main__":
    main()
