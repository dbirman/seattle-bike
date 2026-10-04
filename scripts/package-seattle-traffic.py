#!/usr/bin/env python3
"""Convert Seattle traffic-count exports to typed Parquet tables."""

from __future__ import annotations

import argparse
import gzip
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data" / "seattle-traffic"
DEFAULT_OUTPUT = DATA / "parquet"


def read_table(path: Path) -> pd.DataFrame:
    frame = pd.read_csv(path, thousands=",", low_memory=False)
    frame.columns = [str(column).strip().lower() for column in frame.columns]
    return frame


def to_int(frame: pd.DataFrame, columns: list[str], dtype: str = "Int64") -> None:
    for column in columns:
        if column in frame:
            frame[column] = pd.to_numeric(frame[column], errors="coerce").astype(dtype)


def to_float(frame: pd.DataFrame, columns: list[str]) -> None:
    for column in columns:
        if column in frame:
            frame[column] = pd.to_numeric(frame[column], errors="coerce").astype("float64")


def parse_datetimes(frame: pd.DataFrame, columns: list[str]) -> None:
    for column in columns:
        if column in frame:
            frame[column] = pd.to_datetime(frame[column], format="mixed", errors="coerce")


def write_parquet(frame: pd.DataFrame, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    table = pa.Table.from_pandas(frame, preserve_index=False)
    pq.write_table(table, path, compression="zstd", compression_level=4, use_dictionary=True)


def normalize_studies(frame: pd.DataFrame) -> pd.DataFrame:
    to_int(
        frame,
        [
            "study_id",
            "nsl_id",
            "compkey",
            "counter_type_id",
            "traffic_flow_dir_id",
            "lane_designation_code_id",
            "intended_days",
            "study_length",
            "study_days",
            "study_weekdays",
        ],
    )
    to_float(frame, ["actual_days", "adt", "awdt", "max_eight", "am_pk", "pm_pk"])
    parse_datetimes(frame, ["start_date", "end_date", "add_dttm", "mod_dttm", "record_timestamp"])
    frame["study_year"] = frame["start_date"].dt.year.astype("Int16")
    return frame


def study_metadata(
    studies: pd.DataFrame, study_types: pd.DataFrame
) -> tuple[dict[int, int | None], dict[int, int | None], dict[int, int | None], set[int]]:
    compkeys = dict(zip(studies["study_id"].astype(int), studies["compkey"].tolist()))
    directions = dict(
        zip(studies["study_id"].astype(int), studies["traffic_flow_dir_id"].tolist())
    )
    years = dict(zip(studies["study_id"].astype(int), studies["study_year"].tolist()))
    volume_ids = set(
        study_types.loc[study_types["study_type_descr"] == "VOLUME COUNT", "study_id"]
        .dropna()
        .astype(int)
        .tolist()
    )
    return compkeys, directions, years, volume_ids


def add_study_fields(
    frame: pd.DataFrame,
    compkeys: dict[int, int | None],
    directions: dict[int, int | None],
    years: dict[int, int | None],
    volume_ids: set[int],
) -> pd.DataFrame:
    to_int(frame, ["study_id"])
    frame["compkey"] = pd.to_numeric(frame["study_id"].map(compkeys), errors="coerce").astype(
        "Int64"
    )
    frame["traffic_flow_dir_id"] = pd.to_numeric(
        frame["study_id"].map(directions), errors="coerce"
    ).astype("Int8")
    frame["study_year"] = pd.to_numeric(frame["study_id"].map(years), errors="coerce").astype(
        "Int16"
    )
    frame["is_volume_count"] = frame["study_id"].isin(volume_ids).astype(bool)
    return frame


def build_small_tables(output: Path) -> tuple[pd.DataFrame, pd.DataFrame, dict[str, int]]:
    studies = normalize_studies(read_table(DATA / "traffic-counts-by-study.csv"))
    study_types = read_table(DATA / "traffic-count-study-types.csv")
    to_int(study_types, ["study_id"])

    type_lists = study_types.groupby("study_id")["study_type_descr"].agg(
        lambda values: sorted(set(values.dropna().astype(str)))
    )
    studies["study_types"] = studies["study_id"].map(type_lists).apply(
        lambda value: value if isinstance(value, list) else []
    )

    compkeys, directions, years, volume_ids = study_metadata(studies, study_types)
    studies["is_volume_count"] = studies["study_id"].isin(volume_ids).astype(bool)
    volume_observations = studies.loc[studies["is_volume_count"]].copy()

    write_parquet(studies, output / "studies.parquet")
    write_parquet(study_types, output / "study_types.parquet")
    write_parquet(volume_observations, output / "volume_observations.parquet")

    hourly_path = DATA / "source" / "hourly-counts.csv.gz"
    hourly = read_table(hourly_path)
    hourly = add_study_fields(hourly, compkeys, directions, years, volume_ids)
    to_int(hourly, ["statistic_id", "weekday"])
    to_float(
        hourly,
        [
            "total",
            *[f"hr{hour:02d}_total" for hour in range(1, 25)],
            "am_pk_vol",
            "am_pk_fac",
            "pm_pk_vol",
            "pm_pk_fac",
            "max_8_vol",
            "max_8_fac",
        ],
    )
    parse_datetimes(hourly, ["add_dttm", "mod_dttm"])
    write_parquet(hourly, output / "hourly_counts.parquet")

    row_counts = {
        "studies": len(studies),
        "study_types": len(study_types),
        "volume_observations": len(volume_observations),
        "hourly_counts": len(hourly),
        "volume_observations_with_compkey": int(volume_observations["compkey"].notna().sum()),
    }
    return studies, study_types, row_counts


def build_arcgis_table(output: Path, studies: pd.DataFrame) -> tuple[int, dict[str, int]]:
    source = DATA / "source" / "traffic-studies-featureset.json.gz"
    if not source.exists():
        raise FileNotFoundError(f"Missing public ArcGIS feature export: {source}")
    with gzip.open(source, "rt", encoding="utf-8") as stream:
        features = json.load(stream)["features"]

    frame = pd.DataFrame([feature.get("attributes", {}) for feature in features])
    frame.columns = [str(column).strip().lower() for column in frame.columns]
    coordinates = [feature.get("geometry") or {} for feature in features]
    frame["longitude"] = pd.to_numeric(
        [geometry.get("x") for geometry in coordinates], errors="coerce"
    )
    frame["latitude"] = pd.to_numeric(
        [geometry.get("y") for geometry in coordinates], errors="coerce"
    )
    to_int(
        frame,
        [
            "objectid",
            "study_id",
            "actual_days",
            "intended_days",
            "study_length",
            "study_adt",
            "study_awdt",
            "study_max8",
            "study_ampk",
            "study_pmpk",
            "seg_compkey",
            "stdy_year",
        ],
    )
    frame["compkey"] = frame["seg_compkey"].astype("Int64")
    for column in ["start_date", "end_date"]:
        if column in frame:
            frame[column] = pd.to_datetime(frame[column], unit="ms", utc=True, errors="coerce")
    if "study_type" in frame:
        frame["is_volume_count"] = frame["study_type"].eq("VOLUME COUNT")
    if "flowmap" in frame:
        frame["is_flowmap"] = frame["flowmap"].eq("Y")

    write_parquet(frame, output / "arcgis_traffic_studies.parquet")
    study_ids = set(frame["study_id"].dropna().astype(int))
    socrata_ids = set(studies["study_id"].dropna().astype(int))
    flowmap_by_year = {}
    if "is_flowmap" in frame and "stdy_year" in frame:
        counts = frame.loc[frame["is_flowmap"]].groupby("stdy_year").size()
        flowmap_by_year = {str(int(year)): int(count) for year, count in counts.items() if pd.notna(year)}

    return len(frame), {
        "arcgis_traffic_studies": len(frame),
        "arcgis_traffic_studies_with_compkey": int(frame["compkey"].notna().sum()),
        "arcgis_traffic_studies_volume_count": int(frame["is_volume_count"].sum()),
        "arcgis_traffic_studies_flowmap": int(frame["is_flowmap"].sum()),
        "arcgis_study_ids_matching_socrata": len(study_ids & socrata_ids),
        "arcgis_study_ids_not_in_socrata": len(study_ids - socrata_ids),
        "arcgis_study_ids_missing_from_layer": len(socrata_ids - study_ids),
        "arcgis_traffic_studies_flowmap_by_year": flowmap_by_year,
    }


def build_annual_arterial_table(output: Path) -> tuple[int, dict[str, dict[str, int]]]:
    source_dir = DATA / "source" / "arterial-volume-snapshots"
    source_paths = sorted(source_dir.glob("year=*.featureset.json.gz"))
    if not source_paths:
        raise FileNotFoundError(f"No annual arterial-volume exports found under {source_dir}")

    frames = []
    counts_by_year: dict[str, dict[str, int]] = {}
    for source in source_paths:
        year = source.name.removeprefix("year=").split(".", maxsplit=1)[0]
        with gzip.open(source, "rt", encoding="utf-8") as stream:
            feature_set = json.load(stream)
        features = feature_set["features"]
        frame = pd.DataFrame([feature.get("attributes", {}) for feature in features])
        frame.columns = [str(column).strip().lower() for column in frame.columns]
        frame["snapshot_year"] = int(year)
        frame["geometry_json"] = [
            json.dumps(feature.get("geometry"), separators=(",", ":"))
            if feature.get("geometry") is not None
            else None
            for feature in features
        ]
        to_int(
            frame,
            ["objectid", "objectid_1", "fid", "count_compkey", "compkey", "flowsegid", "awdt_round", "awdt_rounded", "snapshot_year"],
        )
        to_float(
            frame,
            ["countaadt", "countaawdt", "adt", "awdt", "ampk", "pmpk", "shape__length", "shape_leng", "shape_le_1"],
        )
        for column in ["countstart", "start_date", "createdate", "modifiedda"]:
            if column in frame:
                frame[column] = pd.to_datetime(frame[column], unit="ms", utc=True, errors="coerce")
        key_column = next((name for name in ["count_compkey", "compkey"] if name in frame), None)
        frame["compkey"] = pd.to_numeric(frame[key_column], errors="coerce").astype("Int64") if key_column else pd.Series(pd.NA, index=frame.index, dtype="Int64")
        aadt_column = next((name for name in ["countaadt", "adt"] if name in frame), None)
        awdt_column = next((name for name in ["countaawdt", "awdt"] if name in frame), None)
        rounded_column = next((name for name in ["awdt_round", "awdt_rounded"] if name in frame), None)
        frame["aadt"] = pd.to_numeric(frame[aadt_column], errors="coerce") if aadt_column else pd.NA
        frame["awdt"] = pd.to_numeric(frame[awdt_column], errors="coerce") if awdt_column else pd.NA
        frame["awdt_rounded"] = pd.to_numeric(frame[rounded_column], errors="coerce") if rounded_column else pd.NA
        start_column = next((name for name in ["countstart", "start_date"] if name in frame), None)
        frame["count_start"] = frame[start_column] if start_column else pd.NaT
        frames.append(frame)
        counts_by_year[year] = {
            "rows": len(frame),
            "distinct_compkeys": int(frame["compkey"].nunique()),
            "rows_without_compkey": int(frame["compkey"].isna().sum()),
            "estimated_rows": int(frame.get("estimate", pd.Series(index=frame.index, dtype="object")).eq("Y").sum()),
        }

    annual = pd.concat(frames, ignore_index=True, sort=False)
    write_parquet(annual, output / "annual_arterial_volumes.parquet")
    return len(annual), counts_by_year


def build_quarter_hour_table(
    output: Path,
    studies: pd.DataFrame,
    study_types: pd.DataFrame,
    chunk_rows: int,
) -> tuple[int, dict[str, int]]:
    source_dir = DATA / "source" / "quarter-hour-counts-by-year"
    source_paths = sorted(source_dir.glob("count_year=*.csv.gz"))
    if not source_paths:
        raise FileNotFoundError(f"No year-partitioned interval exports found under {source_dir}")
    target = output / "quarter_hour_counts"
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True)

    compkeys, directions, years, volume_ids = study_metadata(studies, study_types)
    row_counts: dict[str, int] = {}
    total = 0
    integer_columns = [
        "count_id",
        "study_id",
        "count_sequence",
        "count_year",
        "count_month",
        "count_day",
        "count_hour",
        "count_minute",
        "count_week",
    ]

    source_manifest_path = source_dir / "manifest.json"
    expected_counts = {}
    if source_manifest_path.exists():
        source_manifest = json.loads(source_manifest_path.read_text())
        expected_counts = source_manifest.get("rows_by_count_year", {})

    for source in source_paths:
        partition = source.name.removesuffix(".csv.gz").split("=", maxsplit=1)[-1]
        parquet_dir = target / f"count_year={partition}"
        parquet_dir.mkdir(parents=True, exist_ok=True)
        parquet_path = parquet_dir / "part-00000.parquet"
        writer: pq.ParquetWriter | None = None
        year_rows = 0
        try:
            with gzip.open(source, "rt", encoding="utf-8", newline="") as csv_file:
                reader = pd.read_csv(
                    csv_file,
                    thousands=",",
                    low_memory=False,
                    chunksize=chunk_rows,
                )
                for frame in reader:
                    frame.columns = [str(column).strip().lower() for column in frame.columns]
                    to_int(frame, integer_columns)
                    to_float(frame, ["initial_count", "current_count"])
                    parse_datetimes(frame, ["add_dttm", "mod_dttm"])
                    frame = add_study_fields(frame, compkeys, directions, years, volume_ids)
                    observed_years = set(frame["count_year"].dropna().astype(int).unique())
                    if observed_years - {int(partition)}:
                        raise RuntimeError(f"{source.name} includes unexpected years {observed_years}")
                    year_rows += len(frame)
                    total += len(frame)
                    payload = frame.drop(columns=["count_year"])
                    table = pa.Table.from_pandas(payload, preserve_index=False)
                    if writer is None:
                        writer = pq.ParquetWriter(
                            parquet_path,
                            table.schema,
                            compression="zstd",
                            compression_level=4,
                            use_dictionary=True,
                        )
                    writer.write_table(table, row_group_size=100_000)
        finally:
            if writer is not None:
                writer.close()

        if expected_counts and year_rows != int(expected_counts.get(partition, -1)):
            raise RuntimeError(
                f"{partition}: packaged {year_rows:,} records, expected "
                f"{int(expected_counts.get(partition, -1)):,}"
            )
        row_counts[partition] = year_rows

    return total, dict(sorted(row_counts.items()))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--chunk-rows", type=int, default=300_000)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)

    studies, study_types, row_counts = build_small_tables(output)
    _, arcgis_counts = build_arcgis_table(output, studies)
    row_counts.update({key: value for key, value in arcgis_counts.items() if isinstance(value, int)})
    annual_arterial_rows, annual_arterial_counts = build_annual_arterial_table(output)
    row_counts["annual_arterial_volume_counts"] = annual_arterial_rows
    quarter_rows, quarter_year_counts = build_quarter_hour_table(
        output, studies, study_types, args.chunk_rows
    )
    row_counts["quarter_hour_counts"] = quarter_rows

    manifest = {
        "downloaded_at_utc": datetime.now(timezone.utc).isoformat(),
        "sources": {
            "studies": "https://cos-data.seattle.gov/api/v3/views/xucb-vzhc/export.csv?accessType=DOWNLOAD",
            "study_types": "https://cos-data.seattle.gov/api/v3/views/s72h-pqjm/export.csv?accessType=DOWNLOAD",
            "hourly_counts": "https://cos-data.seattle.gov/api/v3/views/g32r-fjzp/export.csv?accessType=DOWNLOAD",
            "quarter_hour_counts": "https://cos-data.seattle.gov/api/v3/views/gi49-5uh6/export.csv?accessType=DOWNLOAD",
            "arcgis_traffic_studies": "https://services.arcgis.com/ZOyb2t4B0UYuYNYH/arcgis/rest/services/Traffic_Studies/FeatureServer/0",
            "annual_arterial_volume_snapshots": "https://www.arcgis.com/sharing/rest/content/items/cc17c23f13ca4fe2948b008a9846404d/data?f=json",
        },
        "row_counts": row_counts,
        "quarter_hour_counts_by_count_year": quarter_year_counts,
        "annual_arterial_volume_counts_by_year": annual_arterial_counts,
        "arcgis_traffic_studies_flowmap_by_year": arcgis_counts[
            "arcgis_traffic_studies_flowmap_by_year"
        ],
        "parquet_layout": {
            "studies": "studies.parquet; one row per study with study_types list and is_volume_count flag",
            "study_types": "study_types.parquet; normalized many-to-many study/type lookup",
            "volume_observations": "volume_observations.parquet; VOLUME COUNT study rows, including rows without COMPKEY",
            "hourly_counts": "hourly_counts.parquet; daily/hour summary rows joined to COMPKEY and study metadata",
            "quarter_hour_counts": "quarter_hour_counts/count_year=YYYY/; 15-minute rows with COMPKEY, direction, and volume-count flag",
            "arcgis_traffic_studies": "arcgis_traffic_studies.parquet; Seattle's georeferenced study layer, with compkey and longitude/latitude",
            "annual_arterial_volumes": "annual_arterial_volumes.parquet; yearly segment AADT/AWDT snapshots from Seattle's flow-map group, with COMPKEY and source polyline geometry JSON",
        },
        "notes": [
            "COMPKEY is Seattle's street-segment key and can be joined to Seattle Streets geometry.",
            "ADT and AWDT are total vehicle volumes in these public Socrata tables.",
            "The ArcGIS feature layer uses SEG_COMPKEY; the Parquet table also exposes it as compkey and stores point coordinates in EPSG:4326.",
            "No WSDOT highway count source is included.",
        ],
    }
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest["row_counts"], indent=2))
    print(f"Parquet written to {output}")


if __name__ == "__main__":
    main()
