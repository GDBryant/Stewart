# @stewart/v1-import

- Purpose: Legacy v1 stewart.xml importer: parses the v1 settings XML into v2 YAML config files (one-shot, deletable)
- Surface: `src/api.ts`
- Owns: `v1import.ts` (`importV1Xml`, `parseMiniXml`, per-section helpers `importChannels`/`importAgents`/`importOllamaNumCtx`/`importVisionOverrides`/`importSettings`)
- Depends on: `@stewart/catalog` (lower layers only; `scripts/layers.json`); sole caller is core's `config.importV1` handler. Remove with `rm -r modules/v1-import` + that handler + the settings "Import v1" card
- Fake it: pass a v1 XML string and `parseMiniXml`; assert on the returned `files` and `warnings`
