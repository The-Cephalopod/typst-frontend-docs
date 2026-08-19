# Typst Git Editor

A static, web-deployable Typst editor that uses GitHub repositories as project storage.

## What it does

- Opens public GitHub repositories by URL or `owner/repo`.
- Connects to GitHub with a fine-grained personal access token.
- Opens private repositories when the token has access.
- Shows recent repositories on the home page using browser `localStorage`.
- Searches GitHub repositories.
- Provides a Typst-style three-pane interface: files, Monaco code editor, live preview.
- Compiles Typst in the browser with WebAssembly; there is no compilation server.
- Supports multi-file Typst projects by mapping the repository into the compiler's in-memory filesystem.
- Supports `#import`, `#include`, local images/data files, and Typst Universe package fetching through typst.ts.
- Creates, edits, uploads, renames, and deletes project files in a local working copy.
- Uploads complete folders while preserving their directory structure.
- Turns Typst diagnostics into grouped, clickable messages with file/range navigation and expandable details.
- Supports preview-to-source navigation: click rendered text or repository images to jump back to their source; generated graphics use the nearest source anchor when an exact rendered asset mapping is unavailable.
- Accepts pasted clipboard images in the Typst editor, saves them into a nearby `assets/` folder, and inserts the corresponding `#image(...)` call automatically.
- Commits all pending changes as one real Git commit using GitHub's Git Data REST API.
- Refuses to commit if the branch head changed after the project was opened, reducing accidental overwrites between collaborators.
- Exports the current main Typst document as PDF.
- Lets the user choose which `.typ` file is the preview entry point.

## GitHub token permissions

Create a **fine-grained personal access token** with access to the repositories you want to edit and at least:

- Repository permissions → **Contents: Read and write**
- Metadata read access is included by GitHub.

The token is stored in `localStorage` when “Remember this token on this device” is checked, or in `sessionStorage` otherwise. It is used directly from the browser to call `api.github.com`; this project has no application backend.

For a small trusted group, this is much simpler than maintaining a GitHub OAuth backend. Anyone who can read the browser's local storage can read a remembered token, so use narrowly scoped fine-grained tokens rather than a broad classic PAT.

## Deployment

This project is static. Upload these files to the document root of `docs.finnclayton.com`:

- `index.html`
- `styles.css`
- `app.js`

No build step is required.

### Cloudflare Pages

1. Create a new Pages project.
2. Point it at a GitHub repository containing these files, or use direct upload.
3. Use no build command.
4. Set the output directory to the repository root (`.`).
5. Add the custom domain `docs.finnclayton.com`.

### GitHub Pages

Put the files in a repository and publish the repository root with GitHub Pages. The editor uses hash routing (`#/repo/...`), so no rewrite configuration is required.

### Netlify / Vercel / ordinary web hosting

Serve the directory as static files. No functions or environment variables are required.

## Runtime dependencies

The browser loads these pinned CDN dependencies:

- Monaco Editor `0.56.0`
- typst.ts `0.8.0-rc3`
- typst.ts web compiler `0.8.0-rc3`
- typst.ts renderer `0.8.0-rc3`

The 0.8.0-rc3 typst.ts branch is based on Typst 0.15.0, which is the closest browser compiler currently published to the provided Typst 0.15.1 source release.

## Repository behavior

The editor treats the selected branch as the project state. On load it reads the branch commit and recursive Git tree. Files are loaded into the Typst compiler's in-memory shadow filesystem. Local edits remain only in the browser until the user clicks **Commit**.

A commit uses this sequence:

1. Re-read the branch head and stop if it changed.
2. Create Git blobs for all added/modified files.
3. Create one Git tree based on the current tree.
4. Create one Git commit with the current branch head as its parent.
5. Fast-forward the branch reference to the new commit.

This makes a multi-file edit one commit instead of creating a separate commit for every file.

## Notes / current limitations

- GitHub imposes API rate limits. Connecting GitHub is strongly recommended even for public repositories.
- The editor preloads repository files for correct Typst imports. It caps the browser preview working set at 80 MB and individual files at 25 MB.
- typst.ts currently tracks Typst 0.15.0 in its published 0.8.0 RC. Most Typst 0.15.1 projects should compile unchanged, but this is not byte-for-byte the 0.15.1 compiler from the uploaded source archive.
- Custom fonts committed to a repository are available as files, but automatic discovery of arbitrary font files is not yet wired into the UI. Standard typst.ts font assets work.
- Static SVG output does not expose a complete public click-to-source span API. Text navigation uses Typst's selectable rendered text plus the project include/import graph; repository images are matched back to their source asset, and generated vector shapes fall back to the nearest source anchor.
- This version uses a token connection instead of a GitHub OAuth app, specifically so the site can remain static and easy to deploy.

## Suggested repository name

`typst-git-editor` or `typst-docs-editor`


## Editor navigation upgrades

- Typst compiler errors and warnings are shown as Monaco red/yellow squiggly markers in the responsible source file.
- Preview/source navigation is bidirectional: click rendered output to open its source, or click source text to scroll to the mapped preview element.
- Pasting an image opens an insertion dialog for filename, width, caption, and `#image(...)` vs `#figure(...)`; the image file is created under the current Typst file's `assets/` directory and included in the next commit.
