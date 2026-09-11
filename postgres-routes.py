import json
import math
import os
import re
import shutil
import subprocess
import sys
import unicodedata
from hashlib import sha256

import keyring

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")

SERVICE = "gpx-trasy-postgres"
USER = os.environ.get("PGUSER", "postgres")
KNOWN_TEXT_REPAIRS = {
    "Stre\u00c4\ufffd\ufffd\ufffdno-Min\u00c4\ufffd\ufffd\ufffdol-Vr\u00c3\u00batky": "Stre\u010dno-Min\u010dol-Vr\u00fatky"
}


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


def normalize_search_text(value):
    return "".join(
        character for character in unicodedata.normalize("NFD", value).lower() if not unicodedata.combining(character)
    )


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
            search_text TEXT NOT NULL DEFAULT '',
            saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        ALTER TABLE routes ADD COLUMN IF NOT EXISTS search_text TEXT NOT NULL DEFAULT '';
        CREATE INDEX IF NOT EXISTS routes_search_text_idx ON routes (search_text);

        CREATE TABLE IF NOT EXISTS route_points (
            route_id BIGINT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
            latitude DOUBLE PRECISION NOT NULL,
            longitude DOUBLE PRECISION NOT NULL
        );
        CREATE INDEX IF NOT EXISTS route_points_route_id_idx ON route_points (route_id);
        CREATE INDEX IF NOT EXISTS route_points_coordinates_idx ON route_points (latitude, longitude);
        """
    )
    output = execute("SELECT COALESCE(json_agg(json_build_object('id', id, 'fingerprint', route_fingerprint, 'title', route->>'title', 'fileName', route->>'fileName')), '[]'::json) FROM routes;")
    updates = []
    for route in json.loads(output or "[]"):
        fingerprint = fingerprint_digest(route["fingerprint"])
        if fingerprint != route["fingerprint"]:
            updates.append(f"UPDATE routes SET route_fingerprint = {sql_literal(fingerprint)} WHERE id = {route['id']};")
        search_text = normalize_search_text(f"{route['title'] or ''} {route['fileName'] or ''}")
        updates.append(f"UPDATE routes SET search_text = {sql_literal(search_text)} WHERE id = {route['id']} AND search_text <> {sql_literal(search_text)};")
    if updates:
        execute("\n".join(updates))
    execute(
        """
        INSERT INTO route_points (route_id, latitude, longitude)
        SELECT routes.id, (point->>'lat')::double precision, (point->>'lon')::double precision
        FROM routes
        CROSS JOIN LATERAL jsonb_array_elements(routes.route->'points') AS point
        WHERE NOT EXISTS (SELECT 1 FROM route_points WHERE route_points.route_id = routes.id);
        """
    )


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


def nearby_routes():
    payload = json.load(sys.stdin)
    latitude = float(payload.get("lat"))
    longitude = float(payload.get("lon"))
    radius_km = float(payload.get("radiusKm"))
    if not all(math.isfinite(value) for value in (latitude, longitude, radius_km)) or radius_km <= 0:
        raise ValueError("Invalid city search coordinates.")
    latitude_delta = radius_km / 111.32
    longitude_delta = radius_km / (111.32 * max(math.cos(math.radians(latitude)), 0.01))
    output = execute(
        f"""
        SELECT COALESCE(json_agg(route ORDER BY id DESC), '[]'::json)
        FROM (
            SELECT id, jsonb_build_object('id', id, 'type', type, 'savedAt', saved_at) || route AS route
            FROM routes
            WHERE id IN (
                SELECT DISTINCT route_id
                FROM route_points
                WHERE latitude BETWEEN {latitude - latitude_delta:.12f} AND {latitude + latitude_delta:.12f}
                    AND longitude BETWEEN {longitude - longitude_delta:.12f} AND {longitude + longitude_delta:.12f}
                    AND 6371 * 2 * ASIN(SQRT(
                        POWER(SIN(RADIANS((latitude - {latitude:.12f}) / 2)), 2) +
                        COS(RADIANS({latitude:.12f})) * COS(RADIANS(latitude)) *
                        POWER(SIN(RADIANS((longitude - {longitude:.12f}) / 2)), 2)
                    )) <= {radius_km:.12f}
            )
        ) AS matching_routes;
        """
    )
    return json.loads(output or "[]")


def search_routes():
    payload = json.load(sys.stdin)
    query = normalize_search_text(str(payload.get("query", "")).strip())
    if not query:
        return []
    output = execute(
        f"""
        SELECT COALESCE(json_agg(route ORDER BY id DESC), '[]'::json)
        FROM (
            SELECT id, jsonb_build_object('id', id, 'type', type, 'savedAt', saved_at) || route AS route
            FROM routes
            WHERE search_text LIKE {sql_literal('%' + query + '%')}
        ) AS matching_routes;
        """
    )
    return json.loads(output or "[]")


def repair_mojibake(value):
    if not isinstance(value, str):
        return value
    if value in KNOWN_TEXT_REPAIRS:
        return KNOWN_TEXT_REPAIRS[value]
    for corrupted_text, repaired_text in KNOWN_TEXT_REPAIRS.items():
        if corrupted_text in value:
            return value.replace(corrupted_text, repaired_text)
    if not any(marker in value for marker in ("Ã", "Ä", "�")):
        return value
    for source_encoding in ("latin-1", "cp1250"):
        try:
            return value.encode(source_encoding).decode("utf-8")
        except UnicodeError:
            continue
    return value


def repair_route_text():
    output = execute(
        """
        SELECT COALESCE(json_agg(json_build_object('id', id, 'title', route->>'title', 'fileName', route->>'fileName')), '[]'::json)
        FROM routes;
        """
    )
    for route in json.loads(output or "[]"):
        title = repair_mojibake(route["title"])
        file_name = repair_mojibake(route["fileName"])
        if title != route["title"] or file_name != route["fileName"]:
            execute(
                f"""
                UPDATE routes
                SET route = jsonb_set(jsonb_set(route, '{{title}}', to_jsonb({sql_literal(title)}::text), true), '{{fileName}}', to_jsonb({sql_literal(file_name)}::text), true),
                    search_text = {sql_literal(normalize_search_text(f'{title} {file_name}'))}
                WHERE id = {route['id']};
                """
            )


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
    search_text = normalize_search_text(f"{route.get('title', '')} {route.get('fileName', '')}")
    output = execute(
        f"""
        WITH inserted AS (
            INSERT INTO routes (type, content_hash, route_fingerprint, route, search_text)
            VALUES ({sql_literal(route_type)}, {sql_literal(content_hash)}, {sql_literal(fingerprint)}, {sql_literal(route_json)}::jsonb, {sql_literal(search_text)})
            ON CONFLICT DO NOTHING
            RETURNING id
        ), indexed_points AS (
            INSERT INTO route_points (route_id, latitude, longitude)
            SELECT inserted.id, (point->>'lat')::double precision, (point->>'lon')::double precision
            FROM inserted
            CROSS JOIN LATERAL jsonb_array_elements({sql_literal(route_json)}::jsonb->'points') AS point
        )
        SELECT COALESCE(
            (SELECT json_build_object('saved', true, 'route', json_build_object('id', id)) FROM inserted),
            json_build_object(
                'saved', false,
                'route', (
                    SELECT jsonb_build_object('id', id, 'type', type, 'savedAt', saved_at) || route
                    FROM routes
                    WHERE content_hash = {sql_literal(content_hash)} OR route_fingerprint = {sql_literal(fingerprint)}
                    ORDER BY id DESC
                    LIMIT 1
                )
            )
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
    elif operation == "repair-text":
        repair_route_text()
    elif operation == "list":
        print(json.dumps(list_routes()))
    elif operation == "nearby":
        print(json.dumps(nearby_routes()))
    elif operation == "search":
        print(json.dumps(search_routes()))
    elif operation == "save":
        print(json.dumps(save_route()))
    elif operation == "delete":
        print(json.dumps(delete_route()))
    else:
        raise ValueError("Unknown PostgreSQL route operation.")
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)