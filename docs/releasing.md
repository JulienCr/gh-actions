# Developing and releasing

```bash
pnpm install
pnpm test          # vitest
pnpm typecheck
pnpm build         # regenerates the bundles in <action>/dist/
```

`<action>/dist/index.mjs` is **committed**: the runner executes it as-is, never installing or
building. CI checks the bundle matches the sources; without that guard, a `src/` change
published without a rebuild would silently ship the old bundle to every consuming repo through
the major tag.

## Publishing a version

```bash
git tag v3.0.0 && git push origin v3.0.0
```

`release.yml` reruns the tests and the bundle guard, then moves the major tag `v3`. Repos pinned
to `@v3` pick up the fix on their next PR, nothing to change on their side; `@v3.0.0` pins an
exact version. A breaking change (an input removed or renamed, a default behavior flipped) goes
to the next major: the previous one stays put, and repos migrate on their own schedule.

## Migrations

| From → to | What changes | What to touch |
| --- | --- | --- |
| `v1` → `v2` | Single call, touched files only, becomes three passes plus a merge, with joined imports added. | `timeout-minutes: 40` (25 no longer holds), `uses: .../pr-review@v2`. No input removed or renamed; about 4x more input tokens per PR. `@v1` still works. |
| `v2` → `v3` | All four calls on one model become three moved to `deepseek-v4-flash`, a lower Ollama usage tier, optionally via the DeepSeek API for a prefix cache (see [the per-pass mix](providers.md#the-per-pass-mix)). | Just the tag, `uses: .../pr-review@v3`. Pin `model: glm-5.2:cloud` to keep everything on one model. `::stats::` renamed `promptTokens`/`evalTokens` to `inputTokens`/`outputTokens`. The footer now lists each destination's cache share and cost instead of one model name. No input removed or renamed; `@v2` still works. |
