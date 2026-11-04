# Analysis for the blog post

`blog_figures.py` computes every number quoted in the post
[Dutch public tenders are drawing fewer bidders](https://jakobvongehlen.me/blog/dutch-tenders-fewer-bidders.html)
and renders its four charts.

It reads the Parquet tables the static dashboard ships, so it needs no download or ETL run (about 25 MB, versus
~850 MB raw and several GB of RAM for a full build). Take them from the deployed `gh-pages` branch:

```bash
git fetch origin gh-pages
mkdir -p data/static && git --work-tree=data/static checkout origin/gh-pages -- data && git reset -q
uv run python analysis/blog_figures.py --data data/static/data
```

That writes `analysis/out/numbers.json`. To refresh the charts in the post, pass the post's HTML file; the script
replaces everything between `<!-- fig:NAME -->` and `<!-- /fig:NAME -->`:

```bash
uv run python analysis/blog_figures.py --data data/static/data \
  --post ../jakobvongehlen.github.io/blog/dutch-tenders-fewer-bidders.html
```

The numbers in the post are for the TenderNed release with data up to 30 June 2026 (static build of 3 November 2026).

## Definitions used in the post

- **Competitively tendered lot**: an awarded lot (`lot_competition`) that is not a direct award and has a known
  tender count. Year is the year its award notice was published.
- **Direct award**: procedure type "negotiated without prior publication" (`no_publication`).
- **Before / after**: 2016–2021 and 2022–2025, pooled over lots. 2026 is a half year and is left out of trends.
- **Mix-adjusted single-tender rate**: the rate within each CPV division × buyer type, weighted by that cell's lot
  count over all years.
- **Flags, comparability, persistence**: as in `etl/model.sql` (`flags`, `peer_scores`, `persistence`), counted over
  the four three-year periods, without the `all` period.
- **Flag published as one round**: every award to the flagged top supplier in that buyer × category × period was
  published within 90 days.
