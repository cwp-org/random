# Preprocess depth RDS chunks into browser-readable files for GitHub Pages.
#
# R equivalent of preprocess/preprocess.py (either script produces the same
# output format; run whichever toolchain you have). Reads the five
# Chunk_*.rds files (each a named list of per-site data frames) plus
# Depth_Site_Name_Crosswalk.rds and writes:
#
#   data/manifest.json          - site index, crosswalk, format documentation
#   data/sites/<SITE>.json.gz   - one gzipped columnar JSON file per site
#
# Original values are preserved exactly: DateTime verbatim, POSIXct epoch
# seconds delta-encoded losslessly, Depth_m at full precision, Phase and
# Source_Block run-length encoded.
#
# Requires: install.packages("jsonlite")
# Usage:    Rscript preprocess/preprocess.R   (from the repository root)

library(jsonlite)

chunk_files <- c(
  "Chunk_01_Blue_Ridge.rds",
  "Chunk_02_Central_Maryland.rds",
  "Chunk_03_PRV.rds",
  "Chunk_04_Roberts_Field.rds",
  "Chunk_05_Shannon_Run.rds"
)
expected_sites <- c("BR_2", "BR_3", "CM_1", "CM_2", "PRV_1", "PRV_2",
                    "RF_1", "RF_2", "SR_1", "SR_3")
format_version <- 1

dir.create("data/sites", recursive = TRUE, showWarnings = FALSE)

crosswalk <- readRDS("Depth_Site_Name_Crosswalk.rds")

rle_encode <- function(codes) {
  r <- rle(codes)
  mapply(function(v, l) list(v, l), r$values, r$lengths,
         SIMPLIFY = FALSE, USE.NAMES = FALSE)
}

encode_time <- function(t_num) {
  # Delta-encode epoch seconds; NA -> null; first non-NA stored as 0 (= t0).
  out <- vector("list", length(t_num))
  t0 <- NA_real_
  prev <- NA_real_
  for (i in seq_along(t_num)) {
    v <- t_num[i]
    if (is.na(v)) { out[[i]] <- NA; next }
    if (is.na(t0)) { t0 <- v; out[[i]] <- 0 } else out[[i]] <- v - prev
    prev <- v
  }
  list(t0 = t0, deltas = out)
}

manifest_sites <- list()

for (f in chunk_files) {
  message("Reading ", f)
  chunk <- readRDS(f)
  for (site in names(chunk)) {
    df <- chunk[[site]]
    n <- nrow(df)
    message("Encoding ", site, ": ", n, " rows")

    t_num <- as.numeric(df$DateTime_GMT_minus_5)  # POSIXct -> epoch seconds
    enc <- encode_time(t_num)

    phase_dict <- unique(as.character(df$Phase))
    source_dict <- unique(as.character(df$Source_Block))
    phase_codes <- match(as.character(df$Phase), phase_dict) - 1L
    source_codes <- match(as.character(df$Source_Block), source_dict) - 1L

    payload <- list(
      format_version = format_version,
      site = site,
      source_chunk = f,
      n = n,
      t0 = enc$t0,
      t_delta = enc$deltas,
      dt = as.character(df$DateTime),
      depth = as.list(ifelse(is.na(df$Depth_m), NA, df$Depth_m)),
      phase_dict = phase_dict,
      phase_rle = rle_encode(phase_codes),
      source_dict = source_dict,
      source_rle = rle_encode(source_codes),
      notes = paste("t values reconstruct DateTime_GMT_minus_5 as POSIXct",
                    "epoch seconds; GMT-5 wall-clock time = epoch - 18000",
                    "seconds rendered with UTC formatting. dt is the original",
                    "character DateTime, verbatim, for QA/QC.")
    )

    json <- toJSON(payload, auto_unbox = TRUE, null = "null", na = "null",
                   digits = NA)
    con <- gzfile(file.path("data", "sites", paste0(site, ".json.gz")),
                  "wb", compression = 9)
    writeBin(charToRaw(json), con)
    close(con)

    xw <- crosswalk[crosswalk$Final_List_Name == site, ]
    tv <- t_num[!is.na(t_num)]
    dv <- df$Depth_m[!is.na(df$Depth_m)]
    manifest_sites[[length(manifest_sites) + 1]] <- list(
      id = site,
      file = paste0("sites/", site, ".json.gz"),
      source_chunk = f,
      rows = n,
      rows_missing_time = sum(is.na(t_num)),
      rows_missing_depth = sum(is.na(df$Depth_m)),
      t_min = if (length(tv)) min(tv) else NA,
      t_max = if (length(tv)) max(tv) else NA,
      depth_min = if (length(dv)) min(dv) else NA,
      depth_max = if (length(dv)) max(dv) else NA,
      phases = phase_dict,
      source_blocks = source_dict,
      site_name = if (nrow(xw)) xw$Site_Name[1] else NA,
      standard_site_code = if (nrow(xw)) xw$Standard_Site_Code[1] else NA,
      sensor_id = if (nrow(xw)) xw$Sensor_ID[1] else NA,
      bytes_gz = file.size(file.path("data", "sites", paste0(site, ".json.gz")))
    )
  }
}

got <- vapply(manifest_sites, function(s) s$id, character(1))
if (!all(expected_sites %in% got)) {
  stop("Missing expected sites: ",
       paste(setdiff(expected_sites, got), collapse = ", "))
}

manifest <- list(
  format_version = format_version,
  generated_utc = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
  timezone_note = paste("DateTime_GMT_minus_5 is stored as POSIXct epoch",
                        "seconds; the app renders it as fixed-offset GMT-5",
                        "wall-clock time (epoch - 18000 s, UTC-formatted).",
                        "No daylight-saving adjustment is applied."),
  columns = c("DateTime", "DateTime_GMT_minus_5", "Depth_m", "Phase",
              "Source_Block"),
  sites = manifest_sites,
  crosswalk = crosswalk
)
write(toJSON(manifest, auto_unbox = TRUE, null = "null", na = "null",
             digits = NA, pretty = TRUE), "data/manifest.json")
message("Done.")
