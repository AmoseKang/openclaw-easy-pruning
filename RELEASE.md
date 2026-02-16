# Release Checklist

## 1) Validate code

```bash
npm run clean
npm run build
npm test
```

## 2) Validate package contents

```bash
npm pack --dry-run
```

Expected: only runtime/build/doc files are included (no `node_modules`).

## 3) Validate plugin metadata
- `openclaw.plugin.json`
  - `id`: `easy-pruning`
  - `entry`: `./dist/index.js`
- `package.json`
  - `name`: `easy-pruning`
  - `version`: release version

## 4) Tag & changelog
- Update `CHANGELOG.md`
- Bump `package.json` version if needed
- Create git tag (if publishing)

## 5) Deployment smoke test
- Ensure plugin path is loaded in OpenClaw config
- Ensure `plugins.entries.easy-pruning.enabled = true`
- Run one pruning trigger test and confirm logs include:
  - context summary
  - prune stats
  - cooldown skip behavior
