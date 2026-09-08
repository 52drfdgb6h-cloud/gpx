import json
import os
import re
import shutil
import subprocess
import sys
from hashlib import sha256

import keyring

SERVICE = "gpx-trasy-postgres"
USER = os.environ.get("PGUSER", "postgres")


def sql_literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def normalize_text(value):
    if isinstance(value, str):
        return value.encode("utf-8", "surrogatepass").decode("utf-8", "replace")
    if isinstance(value, list):
        return [normalize_text(item) for item in value]
    if isinstance(value, dict):
        return {key: normalize_text(item) for key, item in value.items()}
    return value


def fingerprint_digest(fingerprint):
    if re.fullmatch(r"[0-9a-f]{64}", fingerprint):
        return fingerprint
    return sha256(fingerprint.encode("utf-8")).hexdigest()


def psql_path():
    configured_path = os.environ.get("PG_PSQL_PATH")
    if configured_path and os.path.isfile(configured_path):
        return configured_path
    executable_path = shutil.which("psql")
    if executable_path:
        return executable_path
    raise RuntimeError("PostgreSQL client psql was not found. Set PG_PSQL_PATH in .env.")


def execute(query):
    password = keyring.get_password(SERVICE, USER)
    if not password:
        raise RuntimeError(
            "Missing PostgreSQL password in Windows Credential Manager "
            f"(service='{SERVICE}'; key='{USER}')."
        )
    environment = os.environ | {"PGPASSWORD": password}
    result = subprocess.run(
        [
            psql_path(),
            "-X",
            "-q",
            "-t",
            "-A",
            "-v",
            "ON_ERROR_STOP=1",
            "-h",
            os.environ.get("PGHOST", "localhost"),
            "-p",
            os.environ.get("PGPORT", "5432"),
            "-U",
            USER,
            "-d",
            os.environ.get("PGDATABASE", "gpx_trasy"),
        ],
        capture_output=True,
        encoding="utf-8",
        env=environment,
        input=query,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "PostgreSQL request failed.")
    return result.stdout.strip()


def initialize():
    execute(
        """
        CREATE TABLE IF NOT EXISTS routes (
            id BIGSERIAL PRIMARY KEY,
            type TEXT NOT NULL CHECK (type IN ('planned', 'actual')),
            content_hash TEXT NOT NULL UNIQUE,
            route_fingerprint TEXT NOT NULL UNIQUE,
            route JSONB NOT NULL,
            saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        """
    )
    output = execute("SELECT COALESCE(json_agg(json_build_object('id', id, 'fingerprint', route_fingerprint)), '[]'::json) FROM routes;")
    for route in json.loads(output or "[]"):
        fingerprint = fingerprint_digest(route["fingerprint"])
        if fingerprint != route["fingerprint"]:
            execute(f"UPDATE routes SET route_fingerprint = {sql_literal(fingerprint)} WHERE id = {route['id']};")


def list_routes():
    output = execute(
        """
        SELECT COALESCE(json_agg(route ORDER BY id DESC), '[]'::json)
        FROM (
            SELECT id, jsonb_build_object('id', id, 'type', type, 'savedAt', saved_at) || route AS route
            FROM routes
        ) AS stored_routes;
        """
    )
    return json.loads(output or "[]")


def save_route():
    payload = json.load(sys.stdin)
    route_type = payload.get("type")
    route = normalize_text(payload.get("route"))
    if route_type not in ("planned", "actual") or not isinstance(route, dict):
        raise ValueError("Invalid route payload.")
    content_hash = route.get("contentHash")
    route_fingerprint = route.get("routeFingerprint")
    if not content_hash or not route_fingerprint:
        raise ValueError("Route is missing its duplicate-detection fields.")
    route_json = json.dumps(route, ensure_ascii=False)
    fingerprint = fingerprint_digest(route_fingerprint)
    output = execute(
        f"""
        WITH inserted AS (
            INSERT INTO routes (type, content_hash, route_fingerprint, route)
            VALUES ({sql_literal(route_type)}, {sql_literal(content_hash)}, {sql_literal(fingerprint)}, {sql_literal(route_json)}::jsonb)
            ON CONFLICT DO NOTHING
            RETURNING id
        )
        SELECT COALESCE(
            (SELECT json_build_object('saved', true, 'route', json_build_object('id', id)) FROM inserted),
            json_build_object('saved', false)
        );
        """
    )
    return json.loads(output)


def delete_route():
    route_id = sys.argv[2]
    if not route_id.isdigit():
        raise ValueError("Invalid route id.")
    output = execute(f"DELETE FROM routes WHERE id = {route_id} RETURNING id;")
    return {"deleted": bool(output)}


try:
    operation = sys.argv[1]
    if operation == "init":
        initialize()
    elif operation == "list":
        print(json.dumps(list_routes()))
    elif operation == "save":
        print(json.dumps(save_route()))
    elif operation == "delete":
        print(json.dumps(delete_route()))
    else:
        raise ValueError("Unknown PostgreSQL route operation.")
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)