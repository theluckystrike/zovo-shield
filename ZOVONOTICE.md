# Zovo Shield — fork notice and statement of changes

Zovo Shield is a modified fork of **uBlock Origin Lite (uBOLite)**, part of the
uBlock project by Raymond Hill ("gorhill") and contributors:

- Upstream project: https://github.com/gorhill/uBlock
- Upstream licence: GNU General Public License v3.0 (see `LICENSE.txt`)
- Upstream copyright: Copyright (C) Raymond Hill and uBlock contributors

This fork remains licensed under **GPL-3.0-only**, the same licence as the
upstream project. All upstream copyright and licence headers in source files
are retained. Files added by this fork carry their own GPL-3.0 headers noting
the modification.

## Provenance

Forked from `gorhill/uBlock` `master` @
`48d25d3c3641abbb381e40ba97554cc9a1d9e91d` (2026-08-25). Only the MV3
("uBOLite") build path (`platform/mv3`, plus shared `src/` assets copied by
`tools/make-mv3.sh`) is shipped; the filtering core, ruleset compiler, and
content/scriptlet engines are upstream's, unmodified in behaviour.

## Summary of modifications

1. **Branding** — product renamed to "Zovo Shield"; new icon artwork; popup and
   dashboard visual theme reworked; upstream name removed from all
   user-facing surfaces (attribution retained here and on the About panel).
2. **Per-site privacy score card** — the popup shows a per-site privacy grade
   computed from tracker requests seen vs. blocked on the current site.
3. **One-click cookie-banner auto-decline** — a popup control that enables the
   bundled cookie/annoyance DNR rulesets in one step.
4. **Element-zapper preset library** — a curated library of cosmetic-filter
   presets layered on top of the upstream element zapper, with JSON
   export/import of user rules.
5. **Weekly blocked-tracker digest** — a weekly digest page with per-domain
   blocked-tracker analytics, driven by `chrome.alarms` and local storage
   only (no data leaves the device).
6. **Optional supporter unlock** — a licence-key check (shape-checked
   `ZOVO-XXXX-XXXX-XXXX-XXXX` keys against a validation endpoint) unlocks
   convenience extras. The filtering core is never gated. As required by the
   GPL, anyone may rebuild this source without the supporter check.

## Privacy

No telemetry. All statistics (score card, digest) are computed and stored
locally in `chrome.storage` on the user's device.

## Source

The complete corresponding source for the distributed package is published at
the repository referenced in the store listing and in the About panel.
