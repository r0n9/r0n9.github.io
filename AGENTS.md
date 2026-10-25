# Repository Guidelines

## Project Structure & Module Organization

This repository is a Hugo-based personal blog. Site configuration lives in `hugo.yaml`; reusable content templates are in `archetypes/`. Long-form posts are Markdown files under `content/posts/`, while short updates live in `content/moments/`. Custom Hugo templates and shortcodes are under `layouts/`, and site-specific CSS and JavaScript are under `assets/`. Public images and favicons belong in `static/images/`. The PaperMod theme is vendored in `themes/PaperMod/`. The independent Go publishing service is in `tools/publisher/`, with its Cloudflare Worker implementation in `tools/publisher/cloudflare/`.

## Build, Test, and Development Commands

- `hugo server -D` starts a live-reloading local server at `http://localhost:1313`, including drafts.
- `hugo --gc --minify` performs a production build and writes generated files to `public/`.
- `hugo new posts/YYYY_MM_DD_title.md` creates a post from the default archetype.
- `./bin/moment "message" [image ...]` creates a moment and optionally copies images into the moments asset area.
- `cd tools/publisher && go run .` runs the publisher locally on port `13133`.
- `cd tools/publisher && go test ./...` runs the Go test suite.

Generated directories such as `public/` and `resources/_gen/` are ignored and should not be committed.

## Coding Style & Naming Conventions

Use two spaces for YAML, HTML, CSS, and JavaScript indentation; follow standard `gofmt` formatting for Go. Keep Hugo front matter valid YAML and use the existing `YYYY_MM_DD_title.md` pattern for posts. Moment filenames use date-based names such as `2026-10-23-030722.md`. Prefer lowercase, descriptive asset names and reference site images with absolute paths such as `/images/example.webp`.

## Testing Guidelines

Run `go test ./...` for publisher changes and add focused `*_test.go` tests beside the Go package under test. For content, layout, or asset changes, verify both `hugo --gc --minify` and a representative page with `hugo server -D`; check links, images, mobile layout, and console errors manually.

## Commit & Pull Request Guidelines

Use short Conventional Commit subjects, for example `feat(posts): publish ...`, `fix(publisher): ...`, `docs: ...`, or `feat(moments): ...`. Keep commits focused. Pull requests should explain the user-visible change, identify relevant content or deployment areas, link an issue when one exists, and include screenshots or a preview URL for visual changes. Mention commands run and any configuration or secret requirements.

## Configuration & Deployment Notes

Do not commit secrets; local publisher settings belong in `tools/publisher/.env`, which is ignored. Pushes to `master` trigger GitHub Actions: Hugo deploys to GitHub Pages, while changes under `tools/publisher/` build release binaries and a GHCR Docker image.
