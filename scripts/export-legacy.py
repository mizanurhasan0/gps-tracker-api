"""Read a consistent SQLite snapshot without changing the source database."""
import json
import pathlib
import sqlite3
import sys

path = pathlib.Path(sys.argv[1]).resolve()
if not path.is_file():
    print('{}')
    sys.exit(0)
connection = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)
connection.row_factory = sqlite3.Row
connection.execute('BEGIN')
if connection.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
    raise ValueError('Legacy SQLite integrity check failed')
result = {}
for name, in connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"):
    quoted = '"' + name.replace('"', '""') + '"'
    result[name] = [dict(row) for row in connection.execute('SELECT * FROM ' + quoted + ' ORDER BY rowid')]
print(json.dumps(result, allow_nan=False))
connection.close()
