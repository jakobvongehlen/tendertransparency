import { Link } from 'react-router-dom'

export default function Method() {
  return (
    <div className="page">
      <div className="prose">
        <h1>How to read this dashboard</h1>
        <p>
          The dashboard puts each award pattern in context: who receives the awards, how that compares with similar buyers
          purchasing similar things, and whether the data is complete enough to support the comparison. A concentrated pattern
          is a reason to ask questions, never proof of wrongdoing or dependence.
        </p>

        <h2>Source</h2>
        <p>
          All data comes from the <a href="https://www.tenderned.nl/cms/nl/aanbesteden-in-cijfers/datasets-aanbestedingen" target="_blank" rel="noreferrer">TenderNed open datasets</a> (OCDS
          format, 2016 onwards), enriched with municipality and province from PDOK and population figures from CBS. Only procedures
          published on TenderNed are covered: most small contracts and many single-quote purchases are never published anywhere, so
          this shows the published part of public purchasing, not all of it.
        </p>

        <h2>Units</h2>
        <ul>
          <li><b>Procedure</b>: all notices about one tender. Award notices that arrived under a new reference (common for notices imported from Mercell) are re-attached when buyer and title or buyer reference match and the award follows within three years.</li>
          <li><b>Awarded lot</b>: each lot counts once. When a lot goes to several suppliers (framework agreements, open-house admission procedures), each supplier gets an equal fraction. This stops a single admission procedure with 300 care providers from dominating the counts.</li>
          <li><b>Buyer</b>: the organisation as registered on TenderNed. Departments that name a municipality (“Gemeente Amsterdam, afdeling ICT”) are combined into that municipality.</li>
          <li><b>Supplier</b>: identified by KvK number. Before 2024 many notices only give a name; a name is matched to a KvK number when the exact name appears with exactly one KvK number elsewhere. Unmatched spelling variants of one company show up as separate suppliers, which makes concentration look lower, not higher.</li>
          <li><b>Category</b>: the CPV division (first two digits) of the lot, or of the procedure when the lot has none.</li>
        </ul>

        <h2>Concentration and peers</h2>
        <ul>
          <li><b>Top-supplier share</b>: share of a buyer's awarded lots in a category and period that went to its most frequent supplier. <b>HHI</b> is the sum of squared supplier shares (1 = a single supplier).</li>
          <li><b>Peers</b>: buyers of the same type and size band that bought in the same category in the same three-year period. Municipalities are sized by population (CBS); other buyers by how many procedures they publish (low, medium, high within their type).</li>
          <li><b>Comparability</b>: a comparison is marked <i>comparable</i> only with at least 5 awarded lots from at least 3 separate procedures, at least 5 peers, at least 60% of lots with an identified supplier, and at most 30% of procedures lacking a discoverable award.</li>
          <li><b>Unusual</b>: comparable, the top supplier won at least half the lots, the concentration (HHI) is in the top 10% of peers, and the top-supplier share is at least 20 percentage points above the peer median. <i>Periods</i> counts the three-year periods in which the same supplier held at least half the lots.</li>
        </ul>
        <p>
          Few lots mean high shares by chance: a buyer with three lots and two suppliers already has a 67% top share. That is why
          small samples are never flagged and why the <Link to="/compare">peer comparison</Link> plots share against the number of lots.
        </p>

        <h2>Values</h2>
        <p>
          Award values are shown as reported, with three corrections. Placeholder amounts below €100 are treated as unknown. When all
          suppliers on a lot report the same amount, it is treated as the lot total and split between them. Amounts far outside what
          the buyer type, the estimated value or the submitted tenders support (for example €1.3bn for a municipal accountancy contract)
          are excluded from totals. Values are missing for roughly half of all awards, so value-based rankings are indicative only.
        </p>

        <h2>Information gaps</h2>
        <p>
          A procedure counts as <i>no award found</i> when its contract notice is older than 12 months at the data cutoff and no award
          or early-termination notice is linked to it. Causes include outcomes published on another platform, links the data does not
          record, and procedures that were quietly abandoned. Below-threshold (national) procedures carry lighter publication duties.
        </p>

        <h2>Refreshing the data</h2>
        <p>
          TenderNed publishes a new dataset every six months. Download the JSON files into <code>data/raw/</code> and run
          <code>etl/ingest.py</code>, <code>etl/enrich.py</code> and <code>etl/model.py</code>.
        </p>
      </div>
    </div>
  )
}
