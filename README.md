**English** | [Русский](README.ru.md)

# GitHub Sync (Mobile) for Obsidian

Sync your Obsidian vault with a GitHub repository — and it works on **iOS** and Android.
The plugin needs neither `git` nor Node.js: it talks to the GitHub REST API (Git Data API) through `requestUrl`.

> The plugin's interface (settings, dialogs, notices) is currently in Russian. Where this README mentions a UI label, the exact Russian text is given in parentheses so you can find it. Command names in the command palette are in English.

- **Pull**: downloads changes from GitHub and automatically merges non-overlapping edits within the same file.
- **Commit & Push**: shows the list of changes, lets you edit the commit message, and makes a single commit to the branch.
- **Sync**: Pull, then Push.
- **Conflicts**: a phone-friendly resolver. For each conflicting hunk you see "Mine (Моё)" and "GitHub" side by side, with buttons "Mine / GitHub / Both / Edit" (Моё / GitHub / Оба / Править). You can pick a version for the whole file at once, or write `<<<<<<< ======= >>>>>>>` markers into the file and fix them in the editor.
- **Auto-sync** (configurable): Pull or Sync on startup, Sync every N minutes.

## How it works

The plugin keeps a "base" on the device — the SHA of each file as of the last sync — and compares three versions: the base, the local one, and the remote one.

| Local | GitHub | What happens |
|---|---|---|
| unchanged | changed | the file is downloaded or deleted |
| changed | unchanged | the file goes into the next push |
| changed | changed | three-way merge (diff3); if the edits overlap, it's a conflict |

Push creates blobs, a tree and a commit, and moves the branch only by fast-forward (`force: false`), so other people's commits are never overwritten.
Push is blocked until all conflicts are resolved.

No `.git` folder is created locally. The history lives on GitHub.

## Installation

1. Build the plugin: `npm install && npm run build`. This produces `main.js`, `manifest.json` and `styles.css`.
2. Copy these three files to `<vault>/.obsidian/plugins/github-sync-mobile/`.
   - **iOS**: if your vault is in iCloud, copy the files from your Mac into the vault folder in iCloud Drive. If not, use the Files app (*On My iPhone → Obsidian → <vault> → .obsidian/plugins*).
   - Another option: publish the plugin repository on GitHub and install it with the **BRAT** plugin.
3. Obsidian → Settings → Community plugins → enable **GitHub Sync (Mobile)**.

## Setup

1. Create a repository on GitHub (it can be empty and private).
2. Create a **fine-grained token**: GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens.
   - *Repository access*: only the repository you need.
   - *Permissions → Contents*: **Read and write**.
3. In the plugin settings, enter the token, owner (Владелец), repository name (Репозиторий) and branch (Ветка), then click "Check" (Проверить).
4. Run **Sync** (the ⟳ icon in the left ribbon, or from the command palette).
   - Empty repository: the whole vault goes into the first commit.
   - Empty vault: everything is downloaded from GitHub.
   - Files on both sides: identical files are left as they are, differing ones become conflicts.

> Tip for iOS: add the *Sync* and *Resolve conflicts* commands to the toolbar (Settings → Mobile → Toolbar).

## Commands

| Command | What it does |
|---|---|
| Sync (pull + push) | Pull, then push with an automatic message |
| Pull | Only download changes |
| Commit & Push | Show changes, ask for a message, then sync |
| Show changes | List local changes and conflicts |
| Resolve conflicts | Open the list of conflicts |
| Mark file as resolved | For a file with markers: mark the conflict as resolved (the file must contain no markers) |

## What isn't synced

Not configurable:
- `.git/`, `.trash/`, `.DS_Store`
- `.obsidian/workspace*.json` and `.obsidian/cache`
- this plugin's `data.json` and `sync-state.json` (they hold the **token** and the device state)

Configurable:
- the whole `.obsidian` folder (synced by default);
- your own `.gitignore`-style patterns.

Files larger than 50 MB are skipped (a GitHub API limit).

## Limitations

- GitHub (github.com) only.
- Very large repositories (more than 100,000 files): GitHub returns a truncated tree, and the plugin reports an error.
- The first sync of a large vault makes one request per file. GitHub's limit is 5,000 requests per hour.
- Symbolic links and submodules in the repository are ignored.

## Development

```bash
npm install
npm run dev     # build in watch mode
npm run build   # tsc + production build
npm test        # vitest: hash, ignore, merge, sync engine against a fake GitHub
```

Layout:
- `src/engine.ts`: pull/push/conflict logic, with no dependencies on Obsidian;
- `src/github.ts`: GitHub API client;
- `src/vaultio.ts`: access to the vault's files;
- `src/ui/`: modal dialogs.
