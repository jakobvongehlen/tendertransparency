"""Run model.sql against data/tenders.duckdb, statement by statement."""

from pathlib import Path

import duckdb

ROOT = Path(__file__).resolve().parent.parent


def main():
    con = duckdb.connect(str(ROOT / "data" / "tenders.duckdb"))
    sql = (Path(__file__).parent / "model.sql").read_text()
    for stmt in con.extract_statements(sql):
        con.execute(stmt)
    for (t,) in con.sql("SELECT table_name FROM duckdb_tables() ORDER BY 1").fetchall():
        print(f"{t:24} {con.sql(f'SELECT count(*) FROM {t}').fetchone()[0]:>10,}")
    con.execute("CHECKPOINT")


if __name__ == "__main__":
    main()
