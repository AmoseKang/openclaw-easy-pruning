# Contributing

Thanks for contributing to Easy Pruning.

## Development setup

```bash
npm install
npm run build
npm test
```

## Quality gate before PR/release

```bash
npm run clean
npm run build
npm test
npm pack --dry-run
```

## Code conventions
- TypeScript (`strict` enabled)
- Keep pruning behavior deterministic and rule-based
- Avoid writing to on-disk session transcript files
- Preserve backward compatibility for config keys where possible

## Commit guidance
Use clear, scoped commit messages, e.g.:
- `fix(build): emit dist/index.js for plugin runtime`
- `feat(pruner): add per-zone deletion stats`
- `docs(readme): clarify threshold semantics`
