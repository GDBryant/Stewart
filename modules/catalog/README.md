# @stewart/catalog

- Purpose: Bundled model price/limits data and model-name normalization
- Surface: `src/api.ts`
- Owns: `catalog.data.json`, `catalog.ts` (`lookupModelInfo`, `blendedCost`, `costTier`, `CATALOG_UPDATED`), `normalize.ts` (`normalizeModel`)
- Depends on: — (leaf) (lower layers only; `scripts/layers.json`)
- Fake it: Pure; call directly or stub `lookupModelInfo` in the consumer
