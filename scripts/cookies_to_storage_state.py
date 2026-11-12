#!/usr/bin/env python3
"""Convert browser cookie exports into a Playwright storageState login profile.

Input: one or more JSON files, each an array of cookies as exported from Chrome
(fields: name, value, domain, path, expirationDate, secure, httpOnly, sameSite,
session, ...). All inputs are merged into ONE profile, e.g.

    cookies_to_storage_state.py --name reddit \\
        --volume firecrawl_playwright_profiles \\
        www.reddit.com_cookies.json old.reddit.com_cookies.json

Output (pick one):
  --volume VOL    write <name>.json straight into the Docker volume used by
                  playwright-service (streamed through `docker run -i`; nothing
                  touches the host disk). Owned by uid 1000 (node), mode 600.
  --out-dir DIR   write <name>.json into DIR (mode 600, atomic rename).

Cookie values are login tokens: this script never prints them, only counts.
One profile per site. Do not seed banks, brokerages or email.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile

NAME_RE = re.compile(r"^[a-z0-9._-]{1,64}$")
SAME_SITE = {"no_restriction": "None", "none": "None", "lax": "Lax", "strict": "Strict"}


def convert(cookie: dict) -> dict | None:
    name, domain = cookie.get("name"), cookie.get("domain")
    if not name or not domain or "value" not in cookie:
        return None
    session = cookie.get("session") or cookie.get("expirationDate") is None
    secure = bool(cookie.get("secure", False))
    same_site = SAME_SITE.get(str(cookie.get("sameSite", "")).lower(), "Lax")
    # Chromium rejects SameSite=None without Secure.
    if same_site == "None" and not secure:
        same_site = "Lax"
    return {
        "name": name,
        "value": cookie["value"],
        "domain": domain,
        "path": cookie.get("path") or "/",
        "expires": -1 if session else float(cookie["expirationDate"]),
        "httpOnly": bool(cookie.get("httpOnly", False)),
        "secure": secure,
        "sameSite": same_site,
    }


def build_state(files: list[str]) -> tuple[dict, int]:
    merged: dict[tuple, dict] = {}
    skipped = 0
    for path in files:
        with open(path, encoding="utf-8-sig") as fh:
            data = json.load(fh)
        if isinstance(data, dict) and isinstance(data.get("cookies"), list):
            data = data["cookies"]
        if not isinstance(data, list):
            raise SystemExit(f"{os.path.basename(path)}: expected a JSON array of cookies")
        for raw in data:
            c = convert(raw) if isinstance(raw, dict) else None
            if c is None:
                skipped += 1
                continue
            merged[(c["name"], c["domain"], c["path"])] = c
    return {"cookies": list(merged.values()), "origins": []}, skipped


def write_dir(out_dir: str, name: str, payload: bytes) -> str:
    os.makedirs(out_dir, mode=0o700, exist_ok=True)
    target = os.path.join(out_dir, f"{name}.json")
    fd, tmp = tempfile.mkstemp(dir=out_dir, prefix=f".{name}.", suffix=".tmp")
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as fh:
            fh.write(payload)
        os.replace(tmp, target)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    return target


def write_volume(volume: str, name: str, payload: bytes, image: str) -> str:
    # name is validated against NAME_RE, so it is safe inside the shell string.
    script = (
        f"umask 077 && cat > /data/profiles/.{name}.tmp && "
        f"chown 1000:1000 /data/profiles/.{name}.tmp && "
        f"chmod 600 /data/profiles/.{name}.tmp && "
        f"mv -f /data/profiles/.{name}.tmp /data/profiles/{name}.json && "
        f"chown 1000:1000 /data/profiles && chmod 700 /data/profiles"
    )
    subprocess.run(
        ["docker", "run", "-i", "--rm", "--network", "none",
         "-v", f"{volume}:/data/profiles", image, "sh", "-c", script],
        input=payload, check=True, stdout=subprocess.DEVNULL,
    )
    return f"{volume}:/data/profiles/{name}.json"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--name", required=True, help="profile name, ^[a-z0-9._-]{1,64}$ (e.g. stocktwits)")
    out = ap.add_mutually_exclusive_group(required=True)
    out.add_argument("--volume", help="Docker volume to write into (e.g. firecrawl_playwright_profiles)")
    out.add_argument("--out-dir", help="directory to write <name>.json into")
    ap.add_argument("--image", default="busybox:1.36", help="helper image for --volume")
    ap.add_argument("files", nargs="+", help="cookie export JSON file(s)")
    args = ap.parse_args()

    if not NAME_RE.fullmatch(args.name) or args.name in (".", ".."):
        raise SystemExit("invalid --name: must match ^[a-z0-9._-]{1,64}$")

    state, skipped = build_state(args.files)
    if not state["cookies"]:
        raise SystemExit("no usable cookies found; nothing written")
    payload = json.dumps(state).encode("utf-8")

    if args.volume:
        where = write_volume(args.volume, args.name, payload, args.image)
    else:
        where = write_dir(args.out_dir, args.name, payload)

    domains = sorted({c["domain"].lstrip(".") for c in state["cookies"]})
    sessions = sum(1 for c in state["cookies"] if c["expires"] == -1)
    print(
        f"profile '{args.name}': {len(state['cookies'])} cookies "
        f"({sessions} session, {skipped} skipped) for {', '.join(domains)} -> {where}",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
