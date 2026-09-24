"""Validate the generated banking POC fixture without external dependencies.

SQLite validates the portable CREATE/INSERT subset. PostgreSQL-specific ALTER
FOREIGN KEY statements are checked against the CSV catalog, not executed here.
"""

import csv
import json
import re
import sqlite3
from collections import Counter, defaultdict
from pathlib import Path


ROOT = Path(__file__).resolve().parent / "banking-poc"


def rows(filename):
    with (ROOT / filename).open(newline="", encoding="utf-8") as handle:
        return list(csv.DictReader(handle))


def validate():
    tables, columns, relationships = rows("tables.csv"), rows("columns.csv"), rows("relationships.csv")
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    assert (len(tables), len(columns), len(relationships)) == (100, 5000, 490)
    assert (manifest["dimension_count"], manifest["fact_count"]) == (42, 58)
    table_names = {r["table_name"] for r in tables}
    assert len(table_names) == 100
    by_table = defaultdict(list)
    for column in columns:
        assert column["table_name"] in table_names
        by_table[column["table_name"]].append(column)
    for table in tables:
        name, entries = table["table_name"], by_table[table["table_name"]]
        assert len(entries) == int(table["column_count"])
        assert len({c["column_name"] for c in entries}) == len(entries)
        assert [int(c["ordinal_position"]) for c in entries] == list(range(1, len(entries) + 1))
        assert sum(c["is_primary_key"] == "True" for c in entries) == 1
        assert all(len(c["column_name"]) <= 63 for c in entries)
    for rel in relationships:
        assert rel["from_table"] in table_names and rel["to_table"] in table_names
        assert rel["from_column"] in {c["column_name"] for c in by_table[rel["from_table"]]}
        assert rel["to_column"] in {c["column_name"] for c in by_table[rel["to_table"]]}
        assert rel["to_table"].startswith("dim_")

    ddl = (ROOT / "schema_postgresql.sql").read_text(encoding="utf-8")
    seed = (ROOT / "seed_small.sql").read_text(encoding="utf-8")
    constraints = re.findall(r"\bCONSTRAINT\s+(\w+)\b", ddl)
    # PostgreSQL truncates identifiers at 63 bytes. Constraint names must remain unique.
    assert len({c[:63] for c in constraints}) == len(constraints)
    assert len(re.findall(r"\bCREATE TABLE\b", ddl)) == 100
    assert len(re.findall(r"\bFOREIGN KEY\b", ddl)) == 490
    portable_ddl = "\n".join(line for line in ddl.splitlines()
                             if not line.startswith("CREATE SCHEMA") and not line.startswith("ALTER TABLE"))
    portable_ddl = portable_ddl.replace("bank_dwh.", "")
    portable_seed = seed.replace("bank_dwh.", "")
    with sqlite3.connect(":memory:") as db:
        db.executescript(portable_ddl)
        db.executescript(portable_seed)
        actual = {t["table_name"]: db.execute(f"SELECT COUNT(*) FROM {t['table_name']}").fetchone()[0] for t in tables}
        assert all(actual[t["table_name"]] == (5 if t["table_type"] == "dimension" else 20) for t in tables)
        for rel in relationships:
            sql = (f"SELECT COUNT(*) FROM {rel['from_table']} AS f LEFT JOIN {rel['to_table']} AS d "
                   f"ON f.{rel['from_column']} = d.{rel['to_column']} "
                   f"WHERE f.{rel['from_column']} IS NOT NULL AND d.{rel['to_column']} IS NULL")
            assert db.execute(sql).fetchone()[0] == 0, rel
    print("Validated: 100 tables, 5,000 columns, 490 relationships, 1,370 seed rows.")


if __name__ == "__main__":
    validate()
