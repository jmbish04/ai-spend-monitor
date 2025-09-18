#!/usr/bin/env python3
import argparse
import hashlib
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Tuple
from urllib.parse import urlparse

import requests

# -----------------------
# Category → URLs mapping
# -----------------------
BY_CATEGORY: Dict[str, List[str]] = {
    "core_context_pack": [
        "https://developers.cloudflare.com/workers/llms-full.txt",
        "https://developers.cloudflare.com/workers-ai/llms-full.txt",
        "https://developers.cloudflare.com/llms.txt",
        "https://developers.cloudflare.com/kv/llms-full.txt",
        "https://developers.cloudflare.com/r2/llms-full.txt",
        "https://developers.cloudflare.com/d1/llms-full.txt",
        "https://developers.cloudflare.com/durable-objects/llms-full.txt",
        "https://developers.cloudflare.com/queues/llms-full.txt",
        "https://developers.cloudflare.com/hyperdrive/llms-full.txt",
        "https://developers.cloudflare.com/developer-platform/llms-full.txt",
    ],
    "compute_and_runtime": [
        "https://developers.cloudflare.com/workers/llms-full.txt",
        "https://developers.cloudflare.com/containers/llms-full.txt",
        "https://developers.cloudflare.com/workflows/llms-full.txt",
        "https://developers.cloudflare.com/pages/llms-full.txt",
    ],
    "ai_and_rag": [
        "https://developers.cloudflare.com/workers-ai/llms-full.txt",
        "https://developers.cloudflare.com/ai-gateway/llms-full.txt",
        "https://developers.cloudflare.com/vectorize/llms-full.txt",
        "https://developers.cloudflare.com/autorag/llms-full.txt",
        "https://developers.cloudflare.com/pipelines/llms-full.txt",
        "https://developers.cloudflare.com/agents/llms-full.txt",
    ],
    "storage_and_databases": [
        "https://developers.cloudflare.com/kv/llms-full.txt",
        "https://developers.cloudflare.com/r2/llms-full.txt",
        "https://developers.cloudflare.com/d1/llms-full.txt",
        "https://developers.cloudflare.com/durable-objects/llms-full.txt",
        "https://developers.cloudflare.com/hyperdrive/llms-full.txt",
    ],
    "messaging_and_eventing": [
        "https://developers.cloudflare.com/queues/llms-full.txt",
        "https://developers.cloudflare.com/pub-sub/llms-full.txt",
    ],
    "rendering_and_media": [
        "https://developers.cloudflare.com/browser-rendering/llms-full.txt",
        "https://developers.cloudflare.com/images/llms-full.txt",
    ],
    "observability": [
        "https://developers.cloudflare.com/logs/llms-full.txt",
    ],
    "integrations_and_routing": [
        "https://developers.cloudflare.com/email-routing/llms-full.txt",
        "https://developers.cloudflare.com/zaraz/llms-full.txt",
    ],
    "meta_and_docs": [
        "https://developers.cloudflare.com/developer-platform/llms-full.txt",
        "https://developers.cloudflare.com/developer-spotlight/llms-full.txt",
    ],
    "global_prompt_assets": [
        "https://developers.cloudflare.com/workers/prompt.txt",
        "https://developers.cloudflare.com/llms.txt",
    ],
}

ARTIFACT_DESCRIPTIONS = {
    "llms-full": "LLM-optimized full context export of the docs",
    "llms": "LLM-optimized brief context export",
    "prompt": "Base prompt template for Workers docs",
}

HEADER_START = "# --- METADATA ---"
HEADER_END = "# --- END METADATA ---"
CONTENT_SHA_KEY = "Content-SHA256"

USER_AGENT = "CF-Docs-Fetcher/1.0 (+local script)"


def now_iso_with_tz() -> str:
    # Local timezone ISO 8601 with offset
    return datetime.now().astimezone().isoformat()


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def parse_url(url: str) -> Tuple[str, str]:
    """
    Returns (service, artifact) for naming.
    - service: path segment before filename or 'root'
    - artifact: filename without .txt (e.g., 'llms-full', 'llms', 'prompt')
    """
    parts = [p for p in urlparse(url).path.split("/") if p]
    if not parts:
        return "root", "unknown"
    if len(parts) == 1:
        service = "root"
        artifact = parts[0].replace(".txt", "")
    else:
        service = parts[-2]
        artifact = parts[-1].replace(".txt", "")
    return service, artifact


def service_title(service: str) -> str:
    if service == "root":
        return "Developers (root)"
    return service.replace("-", " ").title()


def artifact_description(artifact: str) -> str:
    return ARTIFACT_DESCRIPTIONS.get(artifact, artifact.replace("-", " ").title())


def build_header(
    url: str,
    category: str,
    service: str,
    artifact: str,
    retrieved_at: str,
    content_sha: str,
    last_modified: str = "",
    etag: str = "",
) -> str:
    lines = [
        HEADER_START,
        f"# Source-URL: {url}",
        f"# Category: {category}",
        f"# Service: {service} ({service_title(service)})",
        f"# Artifact: {artifact} — {artifact_description(artifact)}",
        f"# Retrieved-At: {retrieved_at}",
        f"# {CONTENT_SHA_KEY}: {content_sha}",
    ]
    if last_modified:
        lines.append(f"# HTTP-Last-Modified: {last_modified}")
    if etag:
        lines.append(f"# HTTP-ETag: {etag}")
    lines.append(HEADER_END)
    return "\n".join(lines) + "\n\n"


def extract_prev_content_sha(file_path: Path) -> str:
    if not file_path.exists():
        return ""
    try:
        with file_path.open("r", encoding="utf-8") as f:
            for line in f:
                if HEADER_END in line:
                    # Stop after header area if present
                    break
                if CONTENT_SHA_KEY in line:
                    m = re.search(rf"{CONTENT_SHA_KEY}:\s*([0-9a-fA-F]+)", line)
                    if m:
                        return m.group(1)
    except Exception:
        pass
    return ""


def archive_existing(current_path: Path, archive_dir: Path) -> None:
    archive_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().astimezone().strftime("%Y%m%d-%H%M%S%z")
    archived = archive_dir / f"{current_path.stem}.{ts}{current_path.suffix}"
    current_path.replace(archived)


def fetch_text(session: requests.Session, url: str) -> Tuple[str, dict]:
    resp = session.get(url, timeout=20)
    resp.raise_for_status()
    return resp.text, resp.headers


def dedupe_preserve_order(items: List[str]) -> List[str]:
    seen = set()
    out = []
    for x in items:
        if x not in seen:
            seen.add(x)
            out.append(x)
    return out


def main():
    parser = argparse.ArgumentParser(description="Fetch Cloudflare LLM doc exports into structured folders with versioning.")
    parser.add_argument("--base", default="cloudflare_docs", help="Base folder to store docs (default: cloudflare_docs)")
    parser.add_argument("--category", action="append", default=[], help="Category to process (can be repeated). Defaults to all.")
    parser.add_argument("--force", action="store_true", help="Write even if content hash unchanged (still archives old).")
    args = parser.parse_args()

    base_dir = Path(args.base)
    base_dir.mkdir(parents=True, exist_ok=True)

    categories = args.category or list(BY_CATEGORY.keys())

    # Build a cache so repeated URLs (across categories) fetch once
    url_cache: Dict[str, Tuple[str, dict]] = {}
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})

    total_downloaded = 0
    total_skipped = 0
    total_archived = 0

    for category in categories:
        urls = dedupe_preserve_order(BY_CATEGORY.get(category, []))
        if not urls:
            print(f"[warn] No URLs for category: {category}")
            continue

        for url in urls:
            service, artifact = parse_url(url)
            cat_dir = base_dir / category / service
            archive_dir = cat_dir / "_archive"
            cat_dir.mkdir(parents=True, exist_ok=True)

            filename = f"{service}-{artifact}.txt" if service != "root" else f"{artifact}.txt"
            current_path = cat_dir / filename

            # Fetch (cache if repeated)
            if url not in url_cache:
                try:
                    text, headers = fetch_text(session, url)
                    url_cache[url] = (text, headers)
                except requests.RequestException as e:
                    print(f"[error] {url}: {e}")
                    continue
            else:
                text, headers = url_cache[url]

            retrieved_at = now_iso_with_tz()
            content_sha = sha256_text(text)
            prev_sha = extract_prev_content_sha(current_path)

            last_modified = headers.get("Last-Modified", "")
            etag = headers.get("ETag", "")

            header = build_header(
                url=url,
                category=category,
                service=service,
                artifact=artifact,
                retrieved_at=retrieved_at,
                content_sha=content_sha,
                last_modified=last_modified,
                etag=etag,
            )
            composed = header + text

            # Decide write/archive
            should_write = args.force or (content_sha != prev_sha) or (not current_path.exists())
            if not should_write:
                total_skipped += 1
                print(f"[skip] {category}/{service}/{filename} (no change)")
                continue

            if current_path.exists():
                try:
                    archive_existing(current_path, archive_dir)
                    total_archived += 1
                    print(f"[archive] -> {archive_dir}")
                except Exception as e:
                    print(f"[warn] failed to archive {current_path}: {e}")

            try:
                with current_path.open("w", encoding="utf-8") as f:
                    f.write(composed)
                total_downloaded += 1
                desc = artifact_description(artifact)
                print(f"[write] {category}/{service}/{filename}  ({desc})")
            except Exception as e:
                print(f"[error] writing {current_path}: {e}")

    print(
        f"\nDone. wrote={total_downloaded}, archived={total_archived}, skipped={total_skipped}\nBase: {base_dir.resolve()}"
    )


if __name__ == "__main__":
    main()