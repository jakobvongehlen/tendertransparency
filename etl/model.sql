-- Build analysis tables from the raw TenderNed tables (see ingest.py / enrich.py).
-- Run with: uv run python etl/model.py

-- ---------------------------------------------------------------- reference
CREATE OR REPLACE TABLE cpv_divisions AS
SELECT * FROM (VALUES
  ('03','Agriculture, farming & fishing products'), ('09','Fuel, energy & electricity'),
  ('14','Mining & minerals'), ('15','Food & beverages'), ('16','Agricultural machinery'),
  ('18','Clothing & footwear'), ('19','Leather, textiles, plastics'), ('22','Printed matter'),
  ('24','Chemical products'), ('30','Office & computing equipment'), ('31','Electrical machinery'),
  ('32','Radio, TV & telecom equipment'), ('33','Medical equipment & pharmaceuticals'),
  ('34','Transport equipment & vehicles'), ('35','Security, fire-fighting & defence equipment'),
  ('37','Sports, music & leisure goods'), ('38','Laboratory & precision instruments'),
  ('39','Furniture & household goods'), ('41','Water supply'), ('42','Industrial machinery'),
  ('43','Mining & construction machinery'), ('44','Construction materials & structures'),
  ('45','Construction work'), ('48','Software & information systems'), ('50','Repair & maintenance'),
  ('51','Installation services'), ('55','Hotel, catering & retail'), ('60','Transport services'),
  ('63','Transport support & travel'), ('64','Postal & telecom services'), ('65','Public utilities'),
  ('66','Financial & insurance services'), ('70','Real estate services'),
  ('71','Architecture, engineering & inspection'), ('72','IT services'), ('73','Research & development'),
  ('75','Public administration & social security'), ('76','Oil & gas services'),
  ('77','Agricultural, forestry & horticultural services'), ('79','Business services (legal, consulting, staffing)'),
  ('80','Education & training'), ('85','Health & social work'), ('90','Waste, sewage & environmental services'),
  ('92','Recreation, culture & sport'), ('98','Other community & personal services')
) t(division, label);

CREATE OR REPLACE TABLE periods AS
SELECT * FROM (VALUES
  ('2016-2018', 2016, 2018), ('2019-2021', 2019, 2021), ('2022-2024', 2022, 2024), ('2025-2026', 2025, 2026)
) t(period, y0, y1);

CREATE OR REPLACE TABLE data_cutoff AS SELECT max(published)::DATE AS cutoff FROM notices;

-- ---------------------------------------------------------------- geo helper
CREATE OR REPLACE MACRO geo_key(pc, loc) AS
  CASE WHEN regexp_full_match(coalesce(pc, ''), '\d{4}[A-Z]{2}') THEN 'pc:' || pc
       WHEN loc IS NOT NULL THEN 'wp:' || lower(trim(loc)) END;

-- ---------------------------------------------------------------- procedure linking
-- Notices of one procedure normally share an ocid. Award notices imported from
-- e-procurement platforms (notably Mercell, 2021+) often arrive under a new ocid,
-- which would make the original procedure look unawarded. Re-attach an orphan
-- award notice to an open contract notice of the same buyer when the title or the
-- buyer's own reference matches and it follows within three years.
CREATE OR REPLACE MACRO norm_title(t) AS trim(regexp_replace(lower(coalesce(t, '')), '[^a-z0-9]+', ' ', 'g'));

-- ocid and buyer_id are rewritten below; keep the originals so re-running this file gives the same result
ALTER TABLE notices ADD COLUMN IF NOT EXISTS source_ocid VARCHAR;
UPDATE notices SET source_ocid = ocid WHERE source_ocid IS NULL;
ALTER TABLE notices ADD COLUMN IF NOT EXISTS source_buyer_id VARCHAR;
UPDATE notices SET source_buyer_id = buyer_id WHERE source_buyer_id IS NULL;

CREATE OR REPLACE TABLE ocid_links AS
WITH o AS (
  SELECT source_ocid AS ocid, arg_max(source_buyer_id, (published, notice_id)) AS buyer_id, min(published)::DATE AS first_pub,
    bool_or(notice_type = 'AAO') AS has_cn, bool_or(notice_type = 'AGO') AS has_can, bool_or(notice_type = 'VBE') AS term,
    list(DISTINCT norm_title(title)) AS titles,
    list(DISTINCT tender_ref) FILTER (tender_ref IS NOT NULL AND NOT regexp_full_match(tender_ref, '\d{5,7}')) AS refs
  FROM notices GROUP BY 1
), cand AS (
  SELECT c.ocid AS parent, a.ocid AS child, a.first_pub - c.first_pub AS gap
  FROM o c JOIN o a ON a.buyer_id = c.buyer_id AND a.ocid <> c.ocid
    AND a.first_pub BETWEEN c.first_pub AND c.first_pub + INTERVAL 3 YEAR
  WHERE c.has_cn AND NOT c.has_can AND NOT c.term
    AND a.has_can AND NOT a.has_cn
    AND (len(list_intersect(list_filter(c.titles, x -> length(x) >= 8), a.titles)) > 0
         OR len(list_intersect(coalesce(c.refs, []), coalesce(a.refs, []))) > 0)
), best AS (
  SELECT *, row_number() OVER (PARTITION BY parent ORDER BY gap, child) AS rp,
            row_number() OVER (PARTITION BY child ORDER BY gap, parent) AS rc
  FROM cand
), related AS (
  -- explicit cross-references between notices of different ocids
  SELECT DISTINCT n.source_ocid AS child, t.source_ocid AS parent
  FROM (SELECT notice_id, source_ocid, published, unnest(string_split(related_notices, ',')) AS rel FROM notices) n
  JOIN notices t ON t.notice_id = TRY_CAST(trim(n.rel) AS BIGINT)
  WHERE t.source_ocid <> n.source_ocid AND t.published <= n.published
)
SELECT child, parent, 'title or reference' AS method FROM best WHERE rp = 1 AND rc = 1
UNION ALL
SELECT DISTINCT ON (child) child, parent, 'related notice' FROM related
WHERE child NOT IN (SELECT child FROM best WHERE rp = 1 AND rc = 1)
  AND parent NOT IN (SELECT child FROM best WHERE rp = 1 AND rc = 1)
ORDER BY child, parent;

-- resolve one level of chaining so every child points at a root
CREATE OR REPLACE TABLE ocid_map AS
SELECT l.child, coalesce(p.parent, l.parent) AS root, l.method
FROM ocid_links l LEFT JOIN ocid_links p ON p.child = l.parent
WHERE coalesce(p.parent, l.parent) <> l.child;

UPDATE notices SET ocid = coalesce((SELECT root FROM ocid_map WHERE child = notices.source_ocid), source_ocid);
UPDATE awards_raw SET ocid = n.ocid FROM notices n WHERE n.notice_id = awards_raw.notice_id;
UPDATE lots SET ocid = n.ocid FROM notices n WHERE n.notice_id = lots.notice_id;
UPDATE bids SET ocid = n.ocid FROM notices n WHERE n.notice_id = bids.notice_id;

-- ---------------------------------------------------------------- supplier identity
-- Before 2024 many award notices carry only a company name. Map a name to a KvK
-- number when that exact normalised name appears with exactly one KvK number elsewhere.
CREATE OR REPLACE TABLE supplier_name_kvk AS
SELECT supplier_name_key, any_value(supplier_kvk) AS kvk
FROM (SELECT DISTINCT supplier_name_key, supplier_kvk FROM awards_raw
      WHERE supplier_kvk IS NOT NULL AND supplier_name_key IS NOT NULL AND length(supplier_name_key) >= 4)
GROUP BY 1 HAVING count(*) = 1;

-- ---------------------------------------------------------------- buyer identity
-- Municipal departments register separately ("Gemeente Amsterdam, afdeling ICT").
-- Roll every organisation whose name identifies a municipality up to that
-- municipality (CBS code), so peers are compared at municipality level.
ALTER TABLE buyers_raw ADD COLUMN IF NOT EXISTS source_buyer_id VARCHAR;
UPDATE buyers_raw SET source_buyer_id = buyer_id WHERE source_buyer_id IS NULL;

CREATE OR REPLACE TABLE buyer_map AS
WITH named AS (
  SELECT source_buyer_id, name, n,
    -- "Gemeente Langedijk nu gemeente Dijk en Waard" belongs to the successor
    regexp_replace(lower(name), '^.*\snu\s+(gemeente\s+)?', 'gemeente ') AS lname
  FROM (SELECT source_buyer_id, name, count(*) AS n FROM buyers_raw GROUP BY ALL)
), parsed AS (
  SELECT source_buyer_id, n,
    regexp_replace(trim(regexp_extract(lname,
      '^(?:college van b(?:urgemeester)?\s?(?:en|&)\s?w(?:ethouders)?\s+(?:van\s+)?(?:de\s+)?)?gemeente(?:bestuur)?\s+(?:van\s+)?([^,(|;]+?)(?:\s+-\s+.*|\s+–\s+.*|,.*|\(.*|\s*\|.*|;.*)?$', 1)),
      '\s*-\s*', '-', 'g') AS mname
  FROM named
), cbs AS (
  SELECT municipality_code, regexp_replace(lower(regexp_replace(name, '\s*\(gemeente\)$', '')), '\s*-\s*', '-', 'g') AS cname
  FROM municipalities
), matched AS (
  -- shared accounts (service centres, joint procurement) name several municipalities:
  -- take the one named on most notices, lowest CBS code on a tie, so rebuilds are reproducible
  SELECT p.source_buyer_id, c.municipality_code AS code
  FROM parsed p JOIN cbs c
    ON c.cname = CASE p.mname WHEN 'den haag' THEN '''s-gravenhage' WHEN 'den bosch' THEN '''s-hertogenbosch'
                              ELSE replace(p.mname, 'demierden', 'de mierden') END
  WHERE p.mname <> '' GROUP BY 1, 2
  QUALIFY row_number() OVER (PARTITION BY p.source_buyer_id ORDER BY sum(p.n) DESC, c.municipality_code) = 1
)
SELECT source_buyer_id, code AS municipality_code, 'GM:' || code AS buyer_id FROM matched;

UPDATE buyers_raw SET buyer_id = coalesce((SELECT buyer_id FROM buyer_map m WHERE m.source_buyer_id = buyers_raw.source_buyer_id), source_buyer_id);
UPDATE notices SET buyer_id = coalesce((SELECT buyer_id FROM buyer_map m WHERE m.source_buyer_id = notices.source_buyer_id), source_buyer_id);

-- ---------------------------------------------------------------- buyers
CREATE OR REPLACE TABLE buyers AS
WITH latest AS (
  SELECT DISTINCT ON (buyer_id) * FROM buyers_raw
  ORDER BY buyer_id, published DESC, notice_id DESC, source_buyer_id, name, postal_code
), attrs AS (
  -- most common value; ties go to the alphabetically first
  SELECT buyer_id,
    arg_max(ca_type, (n_ca, -rank_ca)) FILTER (ca_type IS NOT NULL) AS ca_type,
    arg_max(cofog, (n_cofog, -rank_cofog)) FILTER (cofog IS NOT NULL) AS cofog,
    count(DISTINCT source_buyer_id) AS n_units
  FROM (
    SELECT buyer_id, source_buyer_id, ca_type, cofog,
      count(*) OVER (PARTITION BY buyer_id, ca_type) AS n_ca, dense_rank() OVER (PARTITION BY buyer_id ORDER BY ca_type) AS rank_ca,
      count(*) OVER (PARTITION BY buyer_id, cofog) AS n_cofog, dense_rank() OVER (PARTITION BY buyer_id ORDER BY cofog) AS rank_cofog
    FROM buyers_raw)
  GROUP BY buyer_id
), base AS (
  SELECT l.buyer_id,
         CASE WHEN l.buyer_id LIKE 'GM:%' THEN 'Gemeente ' || regexp_replace(mu.name, '\s*\(gemeente\)$', '') ELSE l.name END AS name,
         l.locality, l.postal_code, a.ca_type, a.cofog,
         coalesce(regexp_replace(mu.name, '\s*\(gemeente\)$', ''), g.municipality) AS municipality,
         coalesce(mu.municipality_code, g.municipality_code) AS municipality_code,
         g.province, g.lat, g.lon,
         CASE WHEN l.buyer_id LIKE 'GM:%' THEN 'gemeente ' || lower(mu.name) ELSE lower(l.name) END AS n,
         a.n_units
  FROM latest l JOIN attrs a USING (buyer_id)
  LEFT JOIN municipalities mu ON 'GM:' || mu.municipality_code = l.buyer_id
  LEFT JOIN geo g ON g.geo_key = geo_key(l.postal_code, l.locality)
)
SELECT * EXCLUDE (n),
  CASE
    WHEN regexp_matches(n, '^(college van b(urgemeester)?\s?(en|&)\s?w(ethouders)?\s+(van\s+)?(de\s+)?gemeente|gemeente(bestuur)?\s|gemeente$)') THEN 'Municipality'
    WHEN regexp_matches(n, '^provincie\s|^provinciaal') THEN 'Province'
    WHEN regexp_matches(n, 'waterschap|hoogheemraadschap|wetterskip|waterschapshuis|zuiveringsschap') THEN 'Water authority'
    WHEN regexp_matches(n, 'veiligheidsregio|brandweer') THEN 'Safety region'
    WHEN regexp_matches(n, 'ministerie|rijkswaterstaat|rijksvastgoed|belastingdienst|defensie|politie|^rijks|rijksoverheid|staat der nederlanden|dienst justiti|uwv|svb|duo|centraal justitieel|cjib|rvo|immigratie|kamer van koophandel|^kvk|logius|nederlandse voedsel|nvwa|douane')
         OR ca_type IN ('Ministerie of andere nationale of federale instantie, met regionale of plaatselijke onderverdeling ervan',
                        'Centrale overheidsinstantie', 'Nationale of federaal agentschap/bureau') THEN 'Central government'
    WHEN regexp_matches(n, 'universit|hogeschool|onderwijs|school|scholen|college\b|\broc\b|lyceum|gymnasium|academie|kinderopvang|kindcentr')
         OR cofog = 'Onderwijs' THEN 'Education'
    WHEN regexp_matches(n, 'ziekenhuis|umc|medisch|zorg|ggd|ggz|gezondheid|kliniek|hospital') OR cofog = 'Gezondheid' THEN 'Health'
    WHEN regexp_matches(n, 'woon|wonen|woning|huisvesting') THEN 'Housing association'
    WHEN regexp_matches(n, 'omgevingsdienst|gemeenschappelijke regeling|samenwerking|werkorganisatie|bedrijfsvoering|bizob|de connectie|meerinzicht|inkoopbureau|\bregio\b|werkbedrijf|belastingen|afvalstoffen|milieudienst|sociale dienst|\bgr\b|shared service')
         THEN 'Joint arrangement'
    WHEN ca_type IN ('Speciale sector', 'Overheidsonderneming', 'Entiteit met bijzondere of uitsluitende rechten') THEN 'Utility / public enterprise'
    ELSE 'Other public body'
  END AS kind
FROM base;

-- municipalities: size by population; everyone else: size by purchasing activity (terciles within kind)
CREATE OR REPLACE TABLE buyer_population AS
SELECT b.buyer_id, arg_max(p.population, p.year) AS population, max(p.year) AS population_year
FROM buyers b JOIN population p ON p.municipality_code = b.municipality_code
WHERE b.kind = 'Municipality' GROUP BY ALL;

-- ---------------------------------------------------------------- procedures
CREATE OR REPLACE TABLE procedures AS
WITH n AS (
  SELECT * FROM notices
), agg AS (
  SELECT ocid,
    min(published)::DATE AS first_published,
    max(published)::DATE AS last_published,
    arg_max(buyer_id, (published, notice_id)) AS buyer_id,
    arg_max(title, (published, notice_id)) AS title,
    coalesce(arg_max(cpv, (published, notice_id)) FILTER (notice_type IN ('AAO','AGO')), arg_max(cpv, (published, notice_id))) AS cpv,
    coalesce(arg_max(cpv_label, (published, notice_id)) FILTER (notice_type IN ('AAO','AGO')), arg_max(cpv_label, (published, notice_id))) AS cpv_label,
    arg_max(category, (published, notice_id)) AS category,
    coalesce(arg_max(procedure, (published, notice_id)) FILTER (notice_type IN ('AAO','AGO')), arg_max(procedure, (published, notice_id))) AS procedure,
    arg_max(scope, (published, notice_id)) AS scope,
    arg_max(nature, (published, notice_id)) AS nature,
    max(est_value) AS est_value,
    max(tender_deadline)::DATE AS tender_deadline,
    bool_or(notice_type = 'AAO') AS has_contract_notice,
    bool_or(notice_type = 'AGO') AS has_award_notice,
    bool_or(notice_type = 'VBE') AS terminated,
    bool_or(notice_type = 'MAC') AS market_consultation,
    bool_or(notice_type = 'VAK') AS prior_info,
    (min(published) FILTER (notice_type = 'AAO'))::DATE AS contract_notice_date,
    (min(published) FILTER (notice_type = 'AGO'))::DATE AS award_notice_date,
    arg_min(notice_id, (published, notice_id)) FILTER (notice_type = 'AAO') AS contract_notice_id,
    arg_max(notice_id, (published, notice_id)) FILTER (notice_type = 'AGO') AS award_notice_id,
    arg_max(notice_id, (published, notice_id)) AS last_notice_id,
    count(*) AS n_notices
  FROM n GROUP BY ocid
)
SELECT agg.*, left(cpv, 2) AS division,
  CASE
    WHEN has_award_notice THEN 'awarded'
    WHEN terminated THEN 'terminated'
    WHEN has_contract_notice AND greatest(contract_notice_date, coalesce(tender_deadline, contract_notice_date))
         > (SELECT cutoff FROM data_cutoff) - INTERVAL 365 DAY THEN 'recent'
    WHEN has_contract_notice THEN 'no_award_found'
    WHEN market_consultation THEN 'market_consultation'
    WHEN prior_info THEN 'prior_information'
    ELSE 'other'
  END AS status,
  -- a contract notice first published before the dataset starts cannot be observed
  (contract_notice_date IS NULL AND has_award_notice AND procedure NOT ILIKE '%zonder%') AS award_without_contract_notice
FROM agg;

-- ---------------------------------------------------------------- awards
-- one row per (procedure, lot, supplier); the latest award notice wins
CREATE OR REPLACE TABLE awards AS
WITH r AS (
  SELECT ar.* REPLACE (
      CASE WHEN ar.supplier_kvk IS NULL AND m.kvk IS NOT NULL THEN 'kvk:' || m.kvk ELSE ar.supplier_key END AS supplier_key,
      coalesce(ar.supplier_kvk, m.kvk) AS supplier_kvk),
    CASE WHEN ar.supplier_kvk IS NOT NULL THEN 'kvk in notice'
         WHEN m.kvk IS NOT NULL THEN 'kvk matched by name'
         ELSE 'name only' END AS id_source
  FROM awards_raw ar LEFT JOIN supplier_name_kvk m USING (supplier_name_key)
  -- "see attachment", "n/a", "several parties": the notice does not name a supplier
  WHERE ar.supplier_key IS NOT NULL
    AND NOT regexp_matches(coalesce(ar.supplier_name_key, ''), '^(zie |see |n a$|nvt$|n v t$|na$|meerdere|diverse|various|onbekend|niet |geen |nog niet|x$)')
), a AS (
  SELECT r.*, n.published::DATE AS published,
    row_number() OVER (PARTITION BY r.ocid, r.lot_id, r.supplier_key ORDER BY n.published DESC, r.notice_id DESC, r.award_id, r.value DESC NULLS LAST, r.supplier_name) AS rn
  FROM r JOIN notices n USING (notice_id)
), d AS (
  SELECT * EXCLUDE (rn) FROM a WHERE rn = 1
), lotcpv AS (
  SELECT DISTINCT ON (ocid, lot_id) ocid, lot_id, cpv, title AS lot_title FROM lots
  ORDER BY ocid, lot_id, notice_id DESC, cpv, title
)
SELECT d.notice_id, d.ocid, d.lot_id, d.award_id, d.supplier_key, d.supplier_kvk, d.supplier_name, d.published,
  year(d.published) AS year,
  p.buyer_id, p.procedure, p.category, p.scope, p.title, lc.lot_title,
  coalesce(lc.cpv, p.cpv) AS cpv, left(coalesce(lc.cpv, p.cpv), 2) AS division,
  -- each lot counts once in total; shared between all suppliers awarded that lot (frameworks, open-house)
  1.0 / count(*) OVER (PARTITION BY d.ocid, d.lot_id) AS weight,
  count(*) OVER (PARTITION BY d.ocid, d.lot_id) AS n_lot_suppliers,
  -- award values: placeholders (< EUR 100), non-EUR and implausible (> EUR 5bn) values are treated as unknown
  CASE WHEN coalesce(d.currency, 'EUR') = 'EUR' AND d.value >= 100 AND d.value < 5e9 THEN d.value / d.n_award_lots END AS value,
  CASE WHEN coalesce(d.currency, 'EUR') = 'EUR' AND d.max_value >= 100 AND d.max_value < 5e9 THEN d.max_value / d.n_award_lots END AS max_value,
  (d.value IS NOT NULL AND (d.value < 100 OR d.value >= 5e9)) AS placeholder_value,
  d.supplier_kvk IS NOT NULL AS has_kvk, d.id_source,
  d.award_date, d.date_signed
FROM d
JOIN procedures p USING (ocid)
LEFT JOIN lotcpv lc ON lc.ocid = d.ocid AND lc.lot_id = d.lot_id;

-- values, second pass:
-- * frameworks often repeat the lot total for every supplier: split it when all suppliers report the same amount
-- * values far outside what the buyer type, the estimate or the bids support are kept as reported but
--   excluded from totals (typical cause: lost decimal separators)
CREATE OR REPLACE TABLE awards AS
WITH x AS (
  SELECT a.*,
    min(a.value) OVER (PARTITION BY a.ocid, a.lot_id) AS lot_min, max(a.value) OVER (PARTITION BY a.ocid, a.lot_id) AS lot_max,
    b.kind, p.est_value, bd.highest_bid
  FROM awards a
  JOIN buyers b USING (buyer_id)
  JOIN procedures p USING (ocid)
  LEFT JOIN (SELECT ocid, lot_id, max(highest_bid) AS highest_bid FROM bids GROUP BY ALL) bd USING (ocid, lot_id)
), y AS (
  SELECT x.*, value AS value_reported,
    CASE WHEN n_lot_suppliers > 1 AND lot_min = lot_max THEN value / n_lot_suppliers ELSE value END AS v,
    CASE WHEN n_lot_suppliers > 1 AND lot_min = lot_max THEN max_value / n_lot_suppliers ELSE max_value END AS mv
  FROM x
)
SELECT y.* EXCLUDE (lot_min, lot_max, v, mv, kind, est_value, highest_bid, value, max_value),
  (v >= 2.5e8 AND kind NOT IN ('Central government', 'Utility / public enterprise'))
    OR (est_value > 0 AND value_reported > 1e6 AND value_reported > 20 * est_value)
    OR (highest_bid > 0 AND value_reported > 1e6 AND value_reported > 20 * highest_bid) AS value_suspect,
  CASE WHEN NOT coalesce((v >= 2.5e8 AND kind NOT IN ('Central government', 'Utility / public enterprise'))
    OR (est_value > 0 AND value_reported > 1e6 AND value_reported > 20 * est_value)
    OR (highest_bid > 0 AND value_reported > 1e6 AND value_reported > 20 * highest_bid), false) THEN v END AS value,
  CASE WHEN mv < 2.5e8 OR kind IN ('Central government', 'Utility / public enterprise') THEN mv END AS max_value
FROM y;

-- ---------------------------------------------------------------- suppliers
CREATE OR REPLACE TABLE suppliers AS
WITH names AS (
  SELECT supplier_key, arg_max(supplier_name, (n, -rank)) AS name, any_value(supplier_kvk) AS kvk
  FROM (SELECT supplier_key, supplier_name, supplier_kvk,
          count(*) OVER (PARTITION BY supplier_key, supplier_name) AS n,
          dense_rank() OVER (PARTITION BY supplier_key ORDER BY supplier_name) AS rank
        FROM awards WHERE supplier_name IS NOT NULL)
  GROUP BY 1
), addr AS (
  SELECT DISTINCT ON (supplier_key) supplier_key, locality, postal_code, country
  FROM suppliers_raw WHERE supplier_key IS NOT NULL
  ORDER BY supplier_key, published DESC, notice_id DESC, postal_code NULLS LAST, locality NULLS LAST
), sme AS (
  SELECT supplier_key, bool_or(sme) AS sme FROM suppliers_raw GROUP BY 1
)
SELECT n.supplier_key, n.name, n.kvk, a.locality, a.postal_code, coalesce(a.country, 'Nederland') AS country,
  coalesce(s.sme, false) AS sme, g.municipality, g.municipality_code, g.province, g.lat, g.lon
FROM names n
LEFT JOIN addr a USING (supplier_key)
LEFT JOIN sme s USING (supplier_key)
LEFT JOIN geo g ON g.geo_key = geo_key(a.postal_code, a.locality)
  AND coalesce(a.country, 'Nederland') IN ('Nederland', 'NL', 'NLD', 'Netherlands');

-- ---------------------------------------------------------------- buyer size bands
CREATE OR REPLACE TABLE buyer_activity AS
SELECT buyer_id, count(*) AS n_procedures, count(*) FILTER (status = 'awarded') AS n_awarded
FROM procedures GROUP BY 1;

CREATE OR REPLACE TABLE buyer_size AS
WITH act AS (
  SELECT b.buyer_id, b.kind, bp.population, coalesce(a.n_procedures, 0) AS n_procedures,
    ntile(3) OVER (PARTITION BY b.kind ORDER BY coalesce(a.n_procedures, 0), b.buyer_id) AS t
  FROM buyers b LEFT JOIN buyer_activity a USING (buyer_id) LEFT JOIN buyer_population bp USING (buyer_id)
)
SELECT buyer_id, population, n_procedures,
  CASE
    WHEN kind = 'Municipality' AND population IS NOT NULL THEN
      CASE WHEN population < 25000 THEN '1: < 25k residents'
           WHEN population < 50000 THEN '2: 25k-50k residents'
           WHEN population < 100000 THEN '3: 50k-100k residents'
           ELSE '4: 100k+ residents' END
    ELSE CASE t WHEN 1 THEN '1: low activity' WHEN 2 THEN '2: medium activity' ELSE '3: high activity' END
  END AS size_band
FROM act;

CREATE OR REPLACE TABLE buyers AS
SELECT b.*, s.size_band, s.population, s.n_procedures FROM buyers b LEFT JOIN buyer_size s USING (buyer_id);

-- ---------------------------------------------------------------- concentration cells
-- one row per buyer x CPV division x period (plus 'all' for the full range)
CREATE OR REPLACE TABLE award_periods AS
SELECT a.*, p.period FROM awards a JOIN periods p ON a.year BETWEEN p.y0 AND p.y1
UNION ALL
SELECT a.*, 'all' AS period FROM awards a;

CREATE OR REPLACE TABLE buyer_supplier_cells AS
SELECT buyer_id, division, period, supplier_key,
  -- rounded: float summation order must not break ties (top supplier) or thresholds between rebuilds
  round(sum(weight), 9) AS w, count(DISTINCT ocid) AS n_procedures, round(sum(value), 2) AS value
FROM award_periods WHERE division IS NOT NULL GROUP BY ALL;

CREATE OR REPLACE TABLE concentration AS
WITH cell AS (
  -- from the unrounded weights: summing the rounded per-supplier shares would turn 5 lots into 4.999999999
  SELECT buyer_id, division, period,
    round(sum(weight), 9) AS n_lots, count(DISTINCT supplier_key) AS n_suppliers,
    round(sum(value), 2) AS value_known
  FROM award_periods WHERE division IS NOT NULL GROUP BY ALL
), top AS (
  SELECT DISTINCT ON (buyer_id, division, period) buyer_id, division, period,
    supplier_key AS top_supplier, w AS top_w, value AS top_value
  FROM buyer_supplier_cells ORDER BY buyer_id, division, period, w DESC, value DESC NULLS LAST, supplier_key
), hhi AS (
  SELECT c.buyer_id, c.division, c.period, round(sum((s.w / c.n_lots) ^ 2), 9) AS hhi
  FROM buyer_supplier_cells s JOIN cell c USING (buyer_id, division, period) GROUP BY ALL
), quality AS (
  SELECT buyer_id, division, period,
    count(DISTINCT ocid) AS n_procedures,
    round(sum(weight * has_kvk::INT) / sum(weight), 9) AS kvk_coverage,
    round(sum(weight * (value IS NOT NULL)::INT) / sum(weight), 9) AS value_coverage
  FROM award_periods GROUP BY ALL
), gaps AS (
  SELECT pr.buyer_id, pr.division, per.period,
    count(*) FILTER (status = 'no_award_found') AS n_no_award,
    count(*) FILTER (status IN ('awarded', 'no_award_found', 'terminated')) AS n_closed
  FROM procedures pr
  JOIN (SELECT * FROM periods UNION ALL SELECT 'all', 2000, 2100) per
    ON year(pr.first_published) BETWEEN per.y0 AND per.y1
  GROUP BY ALL
)
SELECT c.buyer_id, c.division, c.period, c.n_lots, c.n_suppliers, q.n_procedures,
  t.top_supplier, t.top_w / c.n_lots AS top_share, h.hhi,
  c.value_known, t.top_value, q.kvk_coverage, q.value_coverage,
  coalesce(g.n_no_award, 0) AS n_no_award,
  coalesce(g.n_no_award, 0) / nullif(g.n_closed, 0) AS no_award_rate,
  b.kind, b.size_band, b.province
FROM cell c
JOIN top t USING (buyer_id, division, period)
JOIN hhi h USING (buyer_id, division, period)
JOIN quality q USING (buyer_id, division, period)
JOIN buyers b USING (buyer_id)
LEFT JOIN gaps g USING (buyer_id, division, period);

-- peer comparison: same CPV division, period, buyer kind and size band; cells need >= 3 awarded lots
CREATE OR REPLACE TABLE peer_scores AS
WITH eligible AS (SELECT * FROM concentration WHERE n_lots >= 3),
grp AS (
  SELECT division, period, kind, size_band, count(*) AS n_peers,
    median(top_share) AS peer_median_top_share, quantile_cont(top_share, 0.75) AS peer_p75_top_share,
    median(hhi) AS peer_median_hhi, median(n_suppliers) AS peer_median_suppliers,
    median(n_lots) AS peer_median_lots
  FROM eligible GROUP BY ALL
)
SELECT e.*, g.n_peers, g.peer_median_top_share, g.peer_p75_top_share, g.peer_median_hhi,
  g.peer_median_suppliers, g.peer_median_lots,
  cume_dist() OVER (PARTITION BY e.division, e.period, e.kind, e.size_band ORDER BY e.hhi) AS hhi_percentile,
  CASE
    WHEN g.n_peers < 5 THEN 'too few peers'
    WHEN e.kvk_coverage < 0.6 OR coalesce(e.no_award_rate, 0) > 0.3 THEN 'limited data'
    WHEN e.n_lots < 5 OR e.n_procedures < 3 THEN 'small sample'
    ELSE 'comparable'
  END AS comparability
FROM eligible e JOIN grp g USING (division, period, kind, size_band);

-- persistence: same top supplier in several periods
CREATE OR REPLACE TABLE persistence AS
SELECT buyer_id, division, top_supplier,
  count(*) AS n_periods, list(period ORDER BY period) AS periods,
  avg(top_share) AS avg_top_share, sum(n_lots) AS n_lots
FROM concentration WHERE period <> 'all' AND n_lots >= 2 AND top_share >= 0.5
GROUP BY ALL;

CREATE OR REPLACE TABLE flags AS
SELECT s.*, coalesce(p.n_periods, 1) AS persistent_periods,
  (s.comparability = 'comparable' AND s.top_share >= 0.5 AND s.hhi_percentile >= 0.9
     AND s.top_share >= s.peer_median_top_share + 0.2) AS unusual
FROM peer_scores s
LEFT JOIN persistence p ON p.buyer_id = s.buyer_id AND p.division = s.division AND p.top_supplier = s.top_supplier;

-- ---------------------------------------------------------------- competition
-- Tenders received per awarded lot. TenderNed reports "requests" (tenders received) and
-- "electronicBids"; they agree for 97% of lots and "requests" is filled more often.
-- Zero on an awarded lot means not reported.
-- Some imported staffing platforms report "1 tender" on nearly every award without an
-- electronic count: a default rather than a count, so their figures are treated as unknown.
-- Judged per platform and year, as some platforms switched to the default at some point.
CREATE OR REPLACE TABLE platform_bid_quality AS
SELECT n.platform, year(n.published::DATE) AS year, count(*) AS n_award_notices,
  avg((b.requests = 1 AND b.bids IS NULL)::INT) AS default_one_share,
  count(*) >= 20 AND avg((b.requests = 1 AND b.bids IS NULL)::INT) >= 0.75 AS unreliable
FROM bids b JOIN notices n USING (notice_id) WHERE n.notice_type = 'AGO' GROUP BY ALL;

CREATE OR REPLACE TABLE lot_competition AS
WITH l AS (
  SELECT ocid, lot_id, any_value(buyer_id) AS buyer_id, min(year) AS year, any_value(division) AS division,
    any_value(procedure) AS procedure, max(n_lot_suppliers) AS n_winners,
    count(*) OVER (PARTITION BY ocid) AS n_proc_lots
  FROM awards GROUP BY ocid, lot_id
), s AS (
  SELECT b.ocid, b.lot_id, b.lot_level, b.notice_id, coalesce(nullif(b.requests, 0), nullif(b.bids, 0)) AS n
  FROM bids b JOIN notices n USING (notice_id)
  WHERE NOT EXISTS (SELECT 1 FROM platform_bid_quality q
                    WHERE q.unreliable AND q.platform = n.platform AND q.year = year(n.published::DATE))
), per_lot AS (
  SELECT ocid, lot_id, arg_max(n, notice_id) AS n_bids FROM s WHERE lot_level AND n IS NOT NULL GROUP BY ALL
), per_proc AS (
  SELECT ocid, arg_max(n, notice_id) AS n_bids FROM s WHERE NOT lot_level AND n IS NOT NULL GROUP BY ALL
)
SELECT l.* EXCLUDE (n_proc_lots),
  -- a procedure total only says something about a lot if there is one lot, or one tender in total
  coalesce(pl.n_bids, CASE WHEN l.n_proc_lots = 1 OR pp.n_bids = 1 THEN pp.n_bids END) AS n_bids,
  coalesce(l.procedure ILIKE '%zonder%', false) AS no_publication
FROM l LEFT JOIN per_lot pl USING (ocid, lot_id) LEFT JOIN per_proc pp USING (ocid);

-- one row per buyer x CPV division x period, plus division '*' for all categories together
CREATE OR REPLACE TABLE competition AS
WITH per AS (
  SELECT period, y0, y1 FROM periods UNION ALL SELECT 'all', 2000, 2100
), lp AS (
  SELECT l.buyer_id, coalesce(l.division, '?') AS div, p.period, l.no_publication, l.n_bids
  FROM lot_competition l JOIN per p ON l.year BETWEEN p.y0 AND p.y1
), comp AS (
  SELECT buyer_id, period, CASE WHEN grouping(div) = 1 THEN '*' ELSE div END AS division,
    count(*) AS n_lots,
    count(*) FILTER (no_publication) AS n_direct,
    count(*) FILTER (NOT no_publication AND n_bids IS NOT NULL) AS n_bid_lots,
    count(*) FILTER (NOT no_publication AND n_bids = 1) AS n_single,
    -- capped: a few open-house procedures receive hundreds of tenders (least() skips NULLs, hence the filter)
    avg(least(n_bids, 20)) FILTER (NOT no_publication AND n_bids IS NOT NULL) AS avg_bids
  FROM lp GROUP BY GROUPING SETS ((buyer_id, period, div), (buyer_id, period))
), ap AS (
  SELECT a.buyer_id, coalesce(a.division, '?') AS div, p.period, a.weight,
    s.municipality_code IS NOT NULL AS located,
    s.municipality_code = b.municipality_code AS local, s.province = b.province AS same_province
  FROM awards a JOIN per p ON a.year BETWEEN p.y0 AND p.y1
  JOIN suppliers s USING (supplier_key) JOIN buyers b ON b.buyer_id = a.buyer_id
), loc AS (
  -- where the winners are based, in (fractional) lots
  SELECT buyer_id, period, CASE WHEN grouping(div) = 1 THEN '*' ELSE div END AS division,
    round(sum(weight) FILTER (located), 9) AS w_located,
    round(coalesce(sum(weight) FILTER (local), 0), 9) AS w_local,
    round(coalesce(sum(weight) FILTER (same_province), 0), 9) AS w_province
  FROM ap GROUP BY GROUPING SETS ((buyer_id, period, div), (buyer_id, period))
), pp AS (
  SELECT pr.buyer_id, coalesce(pr.division, '?') AS div, per.period, pr.status
  FROM procedures pr JOIN per ON year(pr.first_published) BETWEEN per.y0 AND per.y1
), gaps AS (
  SELECT buyer_id, period, CASE WHEN grouping(div) = 1 THEN '*' ELSE div END AS division,
    count(*) FILTER (status = 'no_award_found') AS n_no_award,
    count(*) FILTER (status IN ('awarded', 'no_award_found', 'terminated')) AS n_closed
  FROM pp GROUP BY GROUPING SETS ((buyer_id, period, div), (buyer_id, period))
)
SELECT c.buyer_id, c.division, c.period, c.n_lots, c.n_direct, c.n_bid_lots, c.n_single, c.avg_bids,
  c.n_single / nullif(c.n_bid_lots, 0) AS single_bid_rate,
  c.n_direct / c.n_lots AS direct_share,
  c.n_bid_lots / nullif(c.n_lots - c.n_direct, 0) AS bid_coverage,
  l.w_local / nullif(l.w_located, 0) AS local_share,
  l.w_province / nullif(l.w_located, 0) AS province_share,
  g.n_no_award, g.n_closed, g.n_no_award / nullif(g.n_closed, 0) AS no_award_rate,
  b.kind, b.size_band, b.province, b.municipality_code
FROM comp c
JOIN buyers b USING (buyer_id)
LEFT JOIN loc l USING (buyer_id, period, division)
LEFT JOIN gaps g USING (buyer_id, period, division)
WHERE c.division <> '?';

-- peers as for concentration (type, size band, category, period); a buyer needs >= 5 lots with known bids
CREATE OR REPLACE TABLE competition_scores AS
WITH e AS (SELECT * FROM competition WHERE n_bid_lots >= 5),
g AS (
  SELECT division, period, kind, size_band, count(*) AS n_bid_peers,
    median(single_bid_rate) AS peer_median_single_bid, quantile_cont(single_bid_rate, 0.75) AS peer_p75_single_bid,
    median(avg_bids) AS peer_median_avg_bids
  FROM e GROUP BY ALL
), d AS (
  SELECT division, period, kind, size_band, median(direct_share) AS peer_median_direct_share
  FROM competition WHERE n_lots >= 5 GROUP BY ALL
)
SELECT c.*, g.n_bid_peers, g.peer_median_single_bid, g.peer_p75_single_bid, g.peer_median_avg_bids,
  d.peer_median_direct_share,
  coalesce(c.n_bid_lots >= 5 AND c.bid_coverage >= 0.6 AND g.n_bid_peers >= 5 AND c.single_bid_rate >= 0.5
    AND c.single_bid_rate >= g.peer_median_single_bid + 0.25, false) AS few_bidders
FROM competition c
LEFT JOIN g USING (division, period, kind, size_band)
LEFT JOIN d USING (division, period, kind, size_band);

-- ---------------------------------------------------------------- relationships
CREATE OR REPLACE TABLE edges AS
SELECT buyer_id, supplier_key, round(sum(weight), 9) AS w, count(DISTINCT ocid) AS n_procedures, round(sum(value), 2) AS value,
  min(year) AS first_year, max(year) AS last_year, list(DISTINCT division ORDER BY division) AS divisions
FROM awards GROUP BY ALL;

DROP TABLE award_periods;
