import json
import sys

import keyring

SERVICE = "strava"


def get_client_credentials():
    client_id = keyring.get_password(SERVICE, "client_id")
    client_secret = keyring.get_password(SERVICE, "client_secret")
    if not client_id or not client_secret:
        raise RuntimeError(
            "Missing Strava credentials in Windows Credential Manager "
            "(service='strava'; keys='client_id', 'client_secret')."
        )
    return {"clientId": client_id, "clientSecret": client_secret}


def get_token():
    access_token = keyring.get_password(SERVICE, "access_token")
    refresh_token = keyring.get_password(SERVICE, "refresh_token")
    expires_at = keyring.get_password(SERVICE, "expires_at")
    if not access_token:
        return None
    return {
        "accessToken": access_token,
        "refreshToken": refresh_token or "",
        "expiresAt": int(expires_at or 0),
    }


def set_token():
    token = json.load(sys.stdin)
    for key, value in {
        "access_token": token.get("accessToken", ""),
        "refresh_token": token.get("refreshToken", ""),
        "expires_at": str(token.get("expiresAt", 0)),
    }.items():
        keyring.set_password(SERVICE, key, value)


def clear_token():
    for key in ("access_token", "refresh_token", "expires_at"):
        try:
            keyring.delete_password(SERVICE, key)
        except keyring.errors.PasswordDeleteError:
            pass


try:
    operation = sys.argv[1]
    if operation == "get-client":
        print(json.dumps(get_client_credentials()))
    elif operation == "get-token":
        print(json.dumps(get_token()))
    elif operation == "set-token":
        set_token()
    elif operation == "clear-token":
        clear_token()
    else:
        raise ValueError("Unknown Strava credential operation.")
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)