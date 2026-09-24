"""Download the TenderNed OCDS yearly datasets into data/raw/.

File links are read from the TenderNed dataset page, because the upload folder in
the URL changes with each release (2025-12/, 2026-07/, ...). Each file is downloaded
to a .part file (resumable), checked to be complete JSON with a "releases" list,
and only then renamed into place. Files already present and valid are skipped.

Files for periods no longer listed (e.g. a half-year file replaced by the full year)
are moved to data/raw/superseded/: ingest.py loads every file in data/raw/, and only
notices are de-duplicated across files, so overlapping files would double-count awards.
"""

import json
import re
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
PAGE = "https://www.tenderned.nl/cms/nl/aanbesteden-in-cijfers/datasets-aanbestedingen"
LINK = re.compile(r'href="(https://www\.tenderned\.nl/[^"]*/(Dataset_Tenderned-[\d-]+\.json))"')
UA = {"User-Agent": "tendertransparency-setup"}


def links():
    with urllib.request.urlopen(urllib.request.Request(PAGE, headers=UA), timeout=60) as r:
        html = r.read().decode("utf-8", "replace")
    found = dict((name, url) for url, name in LINK.findall(html))
    if not found:
        sys.exit(f"no dataset links found on {PAGE}; the page layout may have changed")
    return found


def valid(path):
    try:
        with open(path) as f:
            return isinstance(json.load(f).get("releases"), list)
    except (OSError, ValueError, AttributeError):
        return False


def fetch(url, dest, attempts=4):
    part = dest.with_suffix(".json.part")
    for attempt in range(1, attempts + 1):
        have = part.stat().st_size if part.exists() else 0
        req = urllib.request.Request(url, headers={**UA, "Range": f"bytes={have}-"} if have else UA)
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                resumed = r.status == 206
                total = int(r.headers.get("Content-Length") or 0) + (have if resumed else 0)
                with open(part, "ab" if resumed else "wb") as f:
                    while chunk := r.read(1 << 20):
                        f.write(chunk)
            if total and part.stat().st_size != total:
                raise OSError(f"incomplete: {part.stat().st_size} of {total} bytes")
            if not valid(part):
                part.unlink()  # complete but corrupt: start over
                raise OSError("not valid JSON with a releases list")
            part.rename(dest)
            return
        except urllib.error.HTTPError as e:
            if e.code == 416:  # range not satisfiable: .part is already complete (or garbage)
                if valid(part):
                    part.rename(dest)
                    return
                part.unlink()
            print(f"  attempt {attempt}: {e}")
        except OSError as e:
            print(f"  attempt {attempt}: {e}")
        time.sleep(5 * attempt)
    sys.exit(f"failed to download {url}")


def main():
    RAW.mkdir(parents=True, exist_ok=True)
    available = links()
    print(f"{len(available)} datasets listed on TenderNed")
    for name, url in sorted(available.items()):
        dest = RAW / name
        if dest.exists() and valid(dest):
            print(f"ok       {name}")
            continue
        dest.unlink(missing_ok=True)
        print(f"download {name}")
        fetch(url, dest)
        print(f"         {dest.stat().st_size / 1e6:.0f} MB")

    stale = [p for p in RAW.glob("Dataset_Tenderned-*.json") if p.name not in available]
    if stale:
        (RAW / "superseded").mkdir(exist_ok=True)
        for p in stale:
            p.rename(RAW / "superseded" / p.name)
            print(f"moved superseded {p.name} to data/raw/superseded/")


if __name__ == "__main__":
    main()
