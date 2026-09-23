"""Load TenderNed OCDS release files (data/raw/*.json) into DuckDB raw tables.

Each release is one published notice. Releases sharing an `ocid` belong to the
same procurement procedure (contract notice, rectifications, award notice, ...).
"""

import glob
import json
import re
import sys
from pathlib import Path

import duckdb
import pyarrow as pa

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
DB = ROOT / "data" / "tenders.duckdb"

KVK_RE = re.compile(r"^\d{7,8}$")
LEGAL_FORMS = re.compile(
    r"\b(b\.?\s?v\.?|n\.?\s?v\.?|v\.?\s?o\.?\s?f\.?|c\.?\s?v\.?|holding|groep|group|nederland|netherlands)\b"
)


def num(v):
    try:
        return float(v) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None


def kvk(v):
    s = str(v or "").strip().replace(" ", "")
    return s.zfill(8) if KVK_RE.match(s) else None


def name_key(name):
    s = (name or "").lower()
    s = LEGAL_FORMS.sub(" ", s)
    s = re.sub(r"[^a-z0-9]+", " ", s).strip()
    return s or None


def supplier_key(sid, name):
    k = kvk(sid)
    if k:
        return "kvk:" + k
    n = name_key(name)
    return "name:" + n if n else None


def classification(party, scheme):
    for c in party.get("details", {}).get("classifications", []):
        if c.get("scheme") == scheme:
            return c.get("description")
    return None


def rows_for(release, notices, buyers, suppliers, lots, bids, awards):
    r = release
    t = r.get("tender", {})
    nid = int(r["id"])
    ocid = r["ocid"]
    published = r["date"][:10]
    # TenderNed organisation number (not a KvK number); fall back to the name
    raw_buyer = str(r.get("buyer", {}).get("id") or "").strip()
    buyer_id = raw_buyer if raw_buyer.isdigit() else "name:" + (name_key(r["buyer"].get("name")) or "?")
    src = (r.get("sources") or [{}])[0]
    cls = t.get("classification") or {}

    notices.append(
        dict(
            notice_id=nid,
            ocid=ocid,
            published=published,
            notice_type=t.get("noticeType"),
            notice_label=t.get("noticeTypeDetails"),
            procedure=t.get("procurementMethodDetails"),
            category=t.get("mainProcurementCategory"),
            cpv=cls.get("id"),
            cpv_label=cls.get("description"),
            title=t.get("title"),
            tender_ref=None if t.get("id") in (None, r["id"]) else str(t.get("id")),
            related_notices=str(r.get("relatedNotices") or "") or None,
            description=(t.get("description") or "")[:2000],
            buyer_id=buyer_id,
            buyer_name=r["buyer"].get("name"),
            scope=t.get("nationalOrEuropean"),
            nature=t.get("nature"),
            legal_basis=(t.get("legalBasis") or {}).get("id"),
            est_value=num((t.get("value") or {}).get("amount")),
            n_lots=len(t.get("lots") or []),
            platform=src.get("name") or "TenderNed",
            imported=bool(src.get("imported")),
            contract_start=((t.get("contractPeriod") or {}).get("startDate") or "")[:10] or None,
            contract_end=((t.get("contractPeriod") or {}).get("endDate") or "")[:10] or None,
            tender_deadline=((t.get("tenderPeriod") or {}).get("endDate") or "")[:10] or None,
        )
    )

    for p in r.get("parties", []):
        addr = p.get("address", {})
        if "buyer" in p.get("roles", []):
            buyers.append(
                dict(
                    notice_id=nid,
                    published=published,
                    buyer_id=buyer_id,
                    name=r["buyer"].get("name"),
                    locality=addr.get("locality"),
                    postal_code=(addr.get("postalCode") or "").replace(" ", "").upper() or None,
                    ca_type=classification(p, "TED_CA_TYPE"),
                    cofog=classification(p, "COFOG"),
                )
            )
        if "supplier" in p.get("roles", []):
            suppliers.append(
                dict(
                    notice_id=nid,
                    published=published,
                    supplier_key=supplier_key(p.get("id"), p.get("name")),
                    kvk=kvk(p.get("id")),
                    name=p.get("name"),
                    locality=addr.get("locality"),
                    postal_code=(addr.get("postalCode") or "").replace(" ", "").upper() or None,
                    country=addr.get("countryName"),
                    sme=(p.get("details") or {}).get("scale") == "sme",
                )
            )

    lot_cpv = {}
    for it in t.get("items", []) or []:
        lid = str(it.get("relatedLot") or "1")
        lot_cpv.setdefault(lid, (it.get("classification") or {}).get("id"))
    for lot in t.get("lots", []) or []:
        lid = str(lot.get("id") or "1")
        lots.append(
            dict(notice_id=nid, ocid=ocid, lot_id=lid, title=lot.get("title"), cpv=lot_cpv.get(lid) or cls.get("id"))
        )

    stats = {}
    for s in (r.get("bids") or {}).get("statistics", []):
        lid = str(s.get("relatedLot") or "1")
        stats.setdefault(lid, {})[s["measure"]] = num(s.get("value"))
    for lid, s in stats.items():
        bids.append(
            dict(
                notice_id=nid,
                ocid=ocid,
                lot_id=lid,
                requests=s.get("requests"),
                bids=s.get("electronicBids"),
                complaints=s.get("complaints"),
                lowest_bid=s.get("lowestValidBidValue"),
                highest_bid=s.get("highestValidBidValue"),
            )
        )

    signed = {c.get("awardID"): c.get("dateSigned") for c in r.get("contracts", []) or []}
    for i, a in enumerate(r.get("awards", []) or []):
        lot_ids = [str(x) for x in (a.get("relatedLots") or ["1"])]
        val = a.get("value") or {}
        mval = a.get("maximumValue") or {}
        for s in a.get("suppliers", []) or [{}]:
            for lid in lot_ids:
                awards.append(
                    dict(
                        notice_id=nid,
                        ocid=ocid,
                        award_id=a.get("id") or f"{nid}-{i}",
                        lot_id=lid,
                        n_award_lots=len(lot_ids),
                        supplier_key=supplier_key(s.get("id"), s.get("name")),
                        supplier_kvk=kvk(s.get("id")),
                        supplier_raw_id=None if s.get("id") is None else str(s.get("id")),
                        supplier_name=s.get("name"),
                        supplier_name_key=name_key(s.get("name")),
                        value=num(val.get("amount")),
                        max_value=num(mval.get("amount")),
                        currency=val.get("currency") or mval.get("currency"),
                        award_date=(a.get("date") or "")[:10] or None,
                        date_signed=(signed.get(a.get("id")) or "")[:10] or None,
                    )
                )


def main():
    files = sorted(glob.glob(str(RAW / "*.json")))
    if not files:
        sys.exit(f"no files in {RAW}")
    DB.unlink(missing_ok=True)
    con = duckdb.connect(str(DB))
    tables = ["notices", "buyers_raw", "suppliers_raw", "lots", "bids", "awards_raw"]
    acc = {k: [] for k in tables}
    for f in files:
        releases = json.load(open(f))["releases"]
        for r in releases:
            rows_for(r, acc["notices"], acc["buyers_raw"], acc["suppliers_raw"], acc["lots"], acc["bids"], acc["awards_raw"])
        print(Path(f).name, len(releases))
        del releases
    for name, rows in acc.items():
        tbl = pa.Table.from_pylist(rows)  # noqa: F841 (referenced by duckdb)
        con.execute(f"CREATE TABLE {name} AS SELECT * FROM tbl")
        print(name, len(rows))
    # a notice can appear in two yearly files; keep one copy
    con.execute("CREATE OR REPLACE TABLE notices AS SELECT DISTINCT ON (notice_id) * FROM notices")
    con.close()


if __name__ == "__main__":
    main()
