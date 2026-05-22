"""Optional, lightweight caching layer (Tier 4).

Nothing here is wired into the main scan by default. These are opt-in helpers
for callers that want to skip re-extracting unchanged files. Importing this
package has no side effects.
"""

from edge_agent_scanner.cache.ir_cache import (
    CACHE_VERSION,
    SCANNER_VERSION,
    cached_extraction,
    file_hash,
    invalidate_if_stale,
    load_cache,
    save_cache,
    update_entry,
)

__all__ = [
    "CACHE_VERSION",
    "SCANNER_VERSION",
    "file_hash",
    "load_cache",
    "save_cache",
    "cached_extraction",
    "update_entry",
    "invalidate_if_stale",
]
