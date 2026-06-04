import os
from sqlalchemy import create_engine, text
from dotenv import load_dotenv

load_dotenv()
db_url = os.environ.get("DATABASE_URL")
if not db_url:
    print("DATABASE_URL not found")
    exit(1)

engine = create_engine(db_url)
with engine.connect() as conn:
    conn.execute(text("DELETE FROM alembic_version WHERE version_num = '20260601_0001'"))
    conn.commit()
    print("Fixed alembic_version")
