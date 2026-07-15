#!/usr/bin/env python3
"""
Preprocess depth RDS chunks into browser-readable files for GitHub Pages.

Reads the five Chunk_*.rds files (each an R named list of per-site data
frames) plus Depth_Site_Name_Crosswalk.rds, and writes:

  data/manifest.json          - site index, crosswalk, format documentation
  data/sites/<SITE>.json.gz   - one gzipped columnar JSON file per site

Original values are preserved exactly:
  * DateTime           - original character timestamps, verbatim
  * DateTime_GMT_minus_5 - POSIXct epoch seconds, delta-encoded (lossless,
                           round-trip verified below)
  * Depth_m            - full float64 precision (shortest round-trip repr)
  * Phase, Source_Block - run-length encoded against a per-site dictionary

The browser never runs R: it fetches one .json.gz per selected site and
decompresses it with the native DecompressionStream API.

Requires: pip install rdata pyreadr pandas numpy
Usage:    python3 preprocess/preprocess.py   (run from the repository root)
"""

import gzip
import json
import math
import os
import sys
import warnings
from datetime import datetime, timezone

import numpy as np

warnings.filterwarnings("ignore")

CHUNK_FILES = [
    "Chunk_01_Blue_Ridge.rds",
    "Chunk_02_Central_Maryland.rds",
    "Chunk_03_PRV.rds",
    "Chunk_04_Roberts_Field.rds",
    "Chunk_05_Shannon_Run.rds",
]
CROSSWALK_FILE = "Depth_Site_Name_Crosswalk.rds"
EXPECTED_SITES = ["BR_2", "BR_3", "CM_1", "CM_2", "PRV_1", "PRV_2",
                  "RF_1", "RF_2", "SR_1", "SR_3"]
OUT_DIR = "data"
FORMAT_VERSION = 1


def read_chunks():
    """Read every chunk RDS; each is a named list of per-site data frames."""
    import rdata
    sites = {}
    for f in CHUNK_FILES:
        print(f"Reading {f} ...", flush=True)
        obj = rdata.conversion.convert(rdata.parser.parse_file(f))
        if not isinstance(obj, dict):
            sys.exit(f"{f}: expected a named list of data frames, got {type(obj)}")
        for site, df in obj.items():
            site = str(site)
            if site in sites:
                sys.exit(f"Site {site} appears in more than one chunk file")
            sites[site] = (f, df)
    return sites


def read_crosswalk():
    import pyreadr
    df = list(pyreadr.read_r(CROSSWALK_FILE).values())[0]
    rows = []
    for _, r in df.iterrows():
        rows.append({k: (None if (isinstance(v, float) and math.isnan(v)) or v is None
                         else (v if not isinstance(v, float) else v))
                     for k, v in r.items()})
    return rows


def rle_encode(codes):
    """Run-length encode an integer code sequence as [[code, count], ...]."""
    runs = []
    prev, count = None, 0
    for c in codes:
        if c == prev:
            count += 1
        else:
            if prev is not None:
                runs.append([prev, count])
            prev, count = c, 1
    if prev is not None:
        runs.append([prev, count])
    return runs


def dict_rle(series):
    values = series.tolist()
    dictionary = []
    index = {}
    codes = []
    for v in values:
        v = "" if v is None else str(v)
        if v not in index:
            index[v] = len(dictionary)
            dictionary.append(v)
        codes.append(index[v])
    return dictionary, rle_encode(codes)


def encode_time(t):
    """Delta-encode epoch seconds. t[i] is null when missing; otherwise the
    stored value is t[i] minus the previous non-null t (first non-null is
    stored relative to t0). Deltas may be negative (blocks can overlap)."""
    out = []
    t0 = None
    prev = None
    for v in t:
        if v is None or (isinstance(v, float) and math.isnan(v)):
            out.append(None)
            continue
        iv = v
        # POSIXct values here are whole seconds; keep an int when exact.
        if float(iv) == int(iv):
            iv = int(iv)
        if t0 is None:
            t0 = iv
            out.append(0)
        else:
            out.append(iv - prev)
        prev = iv
    return t0, out


def decode_time(t0, deltas):
    out = []
    prev = None
    for d in deltas:
        if d is None:
            out.append(None)
            continue
        cur = t0 if prev is None else prev + d
        out.append(cur)
        prev = cur
    return out


def depth_list(series):
    out = []
    for v in series.to_numpy(dtype=float):
        out.append(None if math.isnan(v) else float(v))
    return out


def main():
    crosswalk = read_crosswalk()
    xwalk_by_site = {r["Final_List_Name"]: r for r in crosswalk}

    sites = read_chunks()
    missing = [s for s in EXPECTED_SITES if s not in sites]
    extra = [s for s in sites if s not in EXPECTED_SITES]
    if missing:
        sys.exit(f"Missing expected sites: {missing}")
    if extra:
        print(f"WARNING: unexpected extra sites present: {extra}")

    os.makedirs(os.path.join(OUT_DIR, "sites"), exist_ok=True)
    manifest_sites = []

    for site in EXPECTED_SITES + extra:
        chunk_file, df = sites[site]
        n = len(df)
        print(f"Encoding {site}: {n} rows (from {chunk_file})", flush=True)

        expected_cols = ["DateTime", "DateTime_GMT_minus_5", "Depth_m",
                         "Phase", "Source_Block"]
        for c in expected_cols:
            if c not in df.columns:
                sys.exit(f"{site}: missing column {c}")

        t_raw = [None if math.isnan(v) else float(v)
                 for v in df["DateTime_GMT_minus_5"].to_numpy(dtype=float)]
        t0, t_delta = encode_time(t_raw)

        # Lossless round-trip check on the time encoding.
        decoded = decode_time(t0, t_delta)
        for i, (a, b) in enumerate(zip(t_raw, decoded)):
            ok = (a is None and b is None) or (a is not None and b is not None
                                               and float(a) == float(b))
            if not ok:
                sys.exit(f"{site}: time round-trip mismatch at row {i}: {a} != {b}")

        dt = ["" if v is None else str(v) for v in df["DateTime"].tolist()]
        depth = depth_list(df["Depth_m"])
        phase_dict, phase_rle = dict_rle(df["Phase"])
        source_dict, source_rle = dict_rle(df["Source_Block"])

        t_valid = [v for v in t_raw if v is not None]
        payload = {
            "format_version": FORMAT_VERSION,
            "site": site,
            "source_chunk": chunk_file,
            "n": n,
            "t0": t0,
            "t_delta": t_delta,
            "dt": dt,
            "depth": depth,
            "phase_dict": phase_dict,
            "phase_rle": phase_rle,
            "source_dict": source_dict,
            "source_rle": source_rle,
            "notes": ("t values reconstruct DateTime_GMT_minus_5 as POSIXct "
                      "epoch seconds; GMT-5 wall-clock time = epoch - 18000 "
                      "seconds rendered with UTC formatting. dt is the "
                      "original character DateTime, verbatim, for QA/QC."),
        }

        out_path = os.path.join(OUT_DIR, "sites", f"{site}.json.gz")
        raw = json.dumps(payload, separators=(",", ":"),
                         ensure_ascii=False, allow_nan=False).encode("utf-8")
        with open(out_path, "wb") as fh:
            # mtime=0 keeps the output byte-identical across reruns.
            with gzip.GzipFile(fileobj=fh, mode="wb", compresslevel=9, mtime=0) as gz:
                gz.write(raw)

        xw = xwalk_by_site.get(site, {})
        d_valid = [v for v in depth if v is not None]
        manifest_sites.append({
            "id": site,
            "file": f"sites/{site}.json.gz",
            "source_chunk": chunk_file,
            "rows": n,
            "rows_missing_time": sum(1 for v in t_raw if v is None),
            "rows_missing_depth": sum(1 for v in depth if v is None),
            "t_min": min(t_valid) if t_valid else None,
            "t_max": max(t_valid) if t_valid else None,
            "depth_min": min(d_valid) if d_valid else None,
            "depth_max": max(d_valid) if d_valid else None,
            "phases": phase_dict,
            "source_blocks": source_dict,
            "site_name": xw.get("Site_Name"),
            "standard_site_code": xw.get("Standard_Site_Code"),
            "sensor_id": xw.get("Sensor_ID"),
            "bytes_gz": os.path.getsize(out_path),
        })

    manifest = {
        "format_version": FORMAT_VERSION,
        "generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "timezone_note": ("DateTime_GMT_minus_5 is stored as POSIXct epoch "
                          "seconds; the app renders it as fixed-offset GMT-5 "
                          "wall-clock time (epoch - 18000 s, UTC-formatted). "
                          "No daylight-saving adjustment is applied."),
        "columns": ["DateTime", "DateTime_GMT_minus_5", "Depth_m", "Phase",
                    "Source_Block"],
        "sites": manifest_sites,
        "crosswalk": crosswalk,
    }
    with open(os.path.join(OUT_DIR, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=1, ensure_ascii=False)

    total = sum(s["bytes_gz"] for s in manifest_sites)
    print(f"Done. {len(manifest_sites)} sites, {total/1e6:.1f} MB gzipped total.")


if __name__ == "__main__":
    main()
