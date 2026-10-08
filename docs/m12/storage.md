# Persistent state: inventory, schema, recovery, upgrade and downgrade

## Inventory

ColorAdapt persists exactly one thing: the key `coloradapt:settings` in `storage.local` (the browser's extension
storage, per profile, local to the machine). It is checked, not assumed: after the 120-minute soak the test lists
every key in `storage.local` and fails on anything else, on a size of 4 KB or more, and on any text of the page the
workload drove.

| Store                                                  | Content                                                                                                         | Class                                                                    |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `storage.local` key `coloradapt:settings`              | the `UserSettings` object below, including per-site profiles                                                    | **settings** and **user preference**                                     |
| `storage.sync`, `storage.session`, `storage.managed`   | not used                                                                                                        | -                                                                        |
| `localStorage`, `sessionStorage`, IndexedDB, Cache API | not used (a static check of the bundles fails on any reference)                                                 | -                                                                        |
| In memory only                                         | the analysis, the audit snapshot, the AI answers and their cache, the dynamic pipeline's queues, the stylesheet | **temporary / runtime state**, rebuilt on every page load, never written |
| Derived caches                                         | none are persisted; the AI cache is memory only and dies with the audit page                                    | -                                                                        |
| Migration metadata                                     | none: there is no schema version (below)                                                                        | -                                                                        |

Nothing from a page is persisted: no text, URL (beyond the hostname a user chose to give a site profile), form
value, password field or semantic data.

## Schema

`UserSettings` (`src/domain/models/settings.ts`), read by `parseUserSettings` (`src/infrastructure/storage/schema.ts`):

| Field                                                                                                                                     | Type / range                                                                                                   | Default                  |
| ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `enabled`, `improveUIColors`, `improveLinks`, `improveStatusIndicators`, `adaptSVG`, `semanticCuesEnabled`, `adaptCharts`, `showWarnings` | boolean                                                                                                        | `true`                   |
| `adaptImages`, `semanticAIEnabled`                                                                                                        | boolean (opt-in layers)                                                                                        | `false`                  |
| `visionProfile`                                                                                                                           | one of the nine `VISION_PROFILES`                                                                              | `normal`                 |
| `adaptationStrength`                                                                                                                      | number, clamped to 0..1                                                                                        | `0.7`                    |
| `semanticAIProvider`                                                                                                                      | `local-ollama` or `local-http`                                                                                 | `local-ollama`           |
| `semanticAIEndpoint`                                                                                                                      | an `http://` origin on `127.0.0.1`, `localhost` or `[::1]`; nothing else                                       | `http://127.0.0.1:11434` |
| `semanticAIModel`                                                                                                                         | 1 to 60 characters of `A-Za-z0-9_.:/-`, or empty                                                               | empty                    |
| `siteOverrides`                                                                                                                           | map hostname to `{enabled, visionProfile, intensity, adaptUI, adaptCharts, adaptImages}` (own properties only) | empty                    |

The reader is lenient field by field: a missing field takes its default (an older version never wrote it); a present
but unusable field takes its default and is reported by name in one local diagnostic
(`[ColorAdapt] diagnostic: storage-recovered <names>`); a value that is not an object at all yields all defaults. It
never produces a state with more power than the defaults: opt-in layers stay off and the AI endpoint is never remote.
Every write goes through the same parser (M12), so what is stored is always what the reader accepts.

## Recovery

Tested in the real browsers (12 shapes) and in unit tests (17): a string, a number, `null`, an array, an empty object
(a partial write), wrong types, unknown enum values, out-of-range and non-finite numbers, a remote AI endpoint, a
schema version "from the future", site overrides of the wrong shape, and a cleared store with unrelated keys present.
In every case the extension starts with valid settings, keeps the recoverable fields, and does not crash-loop (the
worker is stopped and restarted three times over the damaged state in the failed-upgrade test). A storage read
failure rejects; the router answers `undefined` and the pages say so (popup and options show an alert, a content
script leaves its page unadapted). A write failure stores nothing and the previous value stays.

## Migration

**There is no migration mechanism, and none is needed.** ColorAdapt 0.1.0 has never been published, there is no
schema version field, and every release so far has only added optional fields. The reader's field-by-field defaulting
_is_ the migration: reading an older shape gives the older fields plus defaults for the new ones. This is idempotent
(parsing a parsed value gives the same value), deterministic, and restart-safe by construction (nothing is rewritten
until the user changes a setting). A "partially migrated" or "interrupted migration" state cannot exist because no
step rewrites the stored value.
If a future change needs to _rename_ or _reinterpret_ a field, that is the moment to add a version and a migration;
adding machinery before then would be the unnecessary mechanism M12 was told not to invent.

**Upgrade evidence (Chrome):** the previous frozen builds (m11, and m7 with the oldest shape) create state through
their own backgrounds, the candidate replaces them, and: settings, profiles and per-site overrides are intact, newer
settings come in at their safe defaults, the permission surface is unchanged, one instance adapts the page with the
same colors, and a worker restart changes nothing. An upgrade over a damaged blob recovers the same way.

## Downgrade and rollback

**Downgrade is not supported, and nothing here claims it.** What was measured (candidate, then the m7 build, then the
candidate again): the older build starts, reads the newer blob and adapts the page, because the blob is a plain object
and it ignores fields it does not know. But on its _next write_ it stores only what it knows, so fields that exist
only in the newer version (the AI settings; `adaptImages` for builds that predate it) are dropped. Going forward again
brings those fields back at their defaults, not at the user's earlier values. Storage is therefore **read-compatible
but not write-compatible** backwards. The browser stores control which version users run; ColorAdapt does not
attempt to protect a user's newer-only settings from an older build.
