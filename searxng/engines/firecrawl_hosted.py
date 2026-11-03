# SPDX-License-Identifier: AGPL-3.0-or-later
"""Hosted Firecrawl search (https://api.firecrawl.dev/v2/search) as a SearXNG engine.

Mounted into the container by docker-compose.override.yaml. Runs keyless; set
FIRECRAWL_HOSTED_KEY in the root .env to send a key and raise rate limits.

Why a module instead of json_engine: json_engine inserts the query into the
request body unescaped, so a query containing a double quote or a backslash
("after the midterms") produced invalid JSON and a silent HTTP 400. Here the
body is built with json.dumps.

Note: queries sent to this engine leave the machine and reach Firecrawl's
servers, unlike a purely local search.
"""

import json
import os
import re
import typing as t

from searx.exceptions import (
    SearxEngineAccessDeniedException,
    SearxEngineAPIException,
    SearxEngineTooManyRequestsException,
)
from searx.result_types import EngineResults

if t.TYPE_CHECKING:
    from searx.extended_types import SXNG_Response
    from searx.search.processors import OnlineParams

about = {
    "website": "https://www.firecrawl.dev/",
    "wikidata_id": None,
    "official_api_documentation": "https://docs.firecrawl.dev/api-reference/endpoint/search",
    "use_official_api": True,
    "require_api_key": False,
    "results": "JSON",
}

categories = ["general", "web"]
paging = False
time_range_support = True

base_url = "https://api.firecrawl.dev/v2/search"
results_per_page = 10
snippet_max_chars = 400

# SearXNG time ranges -> Google-style tbs values accepted by Firecrawl
time_range_map = {"day": "qdr:d", "week": "qdr:w", "month": "qdr:m", "year": "qdr:y"}

# The hosted "description" is a markdown page excerpt (headings, images,
# links); reduce it to a plain snippet like the other engines return.
_IMAGE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")
_MARKUP = re.compile(r"[#*_`>|\\]+")
_SPACE = re.compile(r"\s+")


def _snippet(text: str) -> str:
    text = _IMAGE.sub(" ", text or "")
    text = _LINK.sub(r"\1", text)
    text = _MARKUP.sub(" ", text)
    text = _SPACE.sub(" ", text).strip()
    if len(text) > snippet_max_chars:
        text = text[:snippet_max_chars].rsplit(" ", 1)[0] + "…"
    return text


def request(query: str, params: "OnlineParams") -> None:
    """Build the POST request."""
    body: dict[str, t.Any] = {"query": query, "limit": results_per_page}
    tbs = time_range_map.get(params.get("time_range") or "")
    if tbs:
        body["tbs"] = tbs

    params["url"] = base_url
    params["method"] = "POST"
    params["data"] = json.dumps(body)  # ASCII-escaped, safe for any script
    params["headers"]["Content-Type"] = "application/json"
    params["headers"]["Accept"] = "application/json"
    key = os.environ.get("FIRECRAWL_HOSTED_KEY", "").strip()
    if key:
        params["headers"]["Authorization"] = f"Bearer {key}"
    # Map HTTP errors ourselves so SearXNG suspends the engine correctly.
    params["raise_for_httperror"] = False


def response(resp: "SXNG_Response") -> EngineResults:
    """Turn the hosted response into SearXNG results."""
    if resp.status_code == 429:
        raise SearxEngineTooManyRequestsException()
    if resp.status_code in (401, 402, 403):
        raise SearxEngineAccessDeniedException()
    if resp.status_code >= 400:
        raise SearxEngineAPIException(f"HTTP {resp.status_code}")

    data = resp.json()
    if not data.get("success", True):
        raise SearxEngineAPIException(str(data.get("error") or "search failed"))

    res = EngineResults()
    for item in (data.get("data") or {}).get("web") or []:
        url = item.get("url")
        if not url:
            continue
        res.add(
            res.types.MainResult(
                url=url,
                title=item.get("title") or url,
                content=_snippet(item.get("description") or ""),
            )
        )
    return res
