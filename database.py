import os
from pathlib import Path
import psycopg
from psycopg.rows import dict_row


def connect(dsn=None):
    return psycopg.connect(dsn or os.environ['TRAVEL_DATABASE_URL'], row_factory=dict_row, connect_timeout=5,
                           options='-c statement_timeout=15000 -c lock_timeout=5000')


def initialize(dsn=None):
    with connect(dsn) as connection:
        connection.execute(Path(__file__).with_name('schema.sql').read_text())
