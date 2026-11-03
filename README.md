# self-hosted-artifacts

**Keep the builds from your private GitHub repositories on a disk you own.** A small file server,
and a GitHub Action that uploads to it and gives you a download link.

GitHub's artifacts cap private storage at 500 MB on the free plan, which a few app builds fill, and
`actions/upload-artifact` can't target your own server. This action takes the same files by the same
rules, so moving to it means changing the `uses:` line and adding `server-url` and `id-token: write`.
Public repositories' artifacts are free, so this is for private repositories only: the server refuses
uploads from anything else.

- **No secrets to manage.** The action proves who it is with the workflow's OIDC token.
- **No dependencies.** The server installs from npm as one package.
- **No account to download.** Each upload answers with an unguessable link that works with `curl`
  or a browser, and expires by itself.

It's a young project, below 1.0: see [Versions](#versions) and [Not supported](#not-supported).

## Run the server

Needs Node 26 and an existing directory to store files in. Write a config file:

```json
{
  "storeDir": "/srv/artifacts",
  "oidcAudience": "self-hosted-artifacts",
  "oidcRepositoryOwnerId": 123456,
  "linkBases": { "home": "http://192.0.2.10:8420" }
}
```

`oidcRepositoryOwnerId` is the user or organisation whose repositories may upload. Find it with
`gh api users/<owner> --jq .id`, which works for an organisation too.

Then start the server:

```bash
npx self-hosted-artifacts serve --config ./config.json
```

For a long-running service, install a pinned version rather than downloading at each start:
`npm install self-hosted-artifacts@<version>`.

| Setting | Default | Meaning |
| --- | --- | --- |
| `storeDir` | required | Where files live, as an absolute path. Must already exist: see below. |
| `oidcAudience` | required | The token audience to accept. The action's `audience` must match. |
| `oidcRepositoryOwnerId` | required | The numeric ID of the user or organisation whose repositories may upload. |
| `linkBases` | required | Object of label to base URL, `http` or `https`, with no query or fragment. Each upload answers with one link per label. |
| `host` | `"0.0.0.0"` | Address to listen on. |
| `port` | `8420` | Port to listen on. |
| `defaultRetentionDays` | `90` | Days to keep a file when the upload doesn't say. |
| `maxRetentionDays` | `90` | The cap. A larger request is clamped, and the real expiry comes back. |
| `minFreeGiB` | `20` | Refuse an upload that would leave less free space than this. |
| `maxFileGiB` | `2` | The largest file accepted. |

A missing, malformed or unknown setting stops the server at startup with a message naming it. Nothing
in the file is secret.

**The server never creates `storeDir`**, so files can't land on the wrong disk while a volume is
unmounted. On macOS, a directory at a volume's mount path would also send the real disk elsewhere
when it mounts. While the store is missing, uploads get `503`, downloads `404` and `/healthz` `503`,
and everything recovers by itself when it returns, with no restart. The server only creates its own
`tmp/`, `artifacts/` and `runs/` inside it.

**Run one server per store, on a disk with hard links** (APFS, ext4 or XFS, say; not exFAT). A name is
a hard link to its artifact's metadata, and uploads take turns to publish inside the server's process.

Links come only from `linkBases`, never from `Host` or `X-Forwarded-*`, so the links in a response
can't be steered by the request.

Logs go to stdout in logfmt. Expired files and abandoned uploads are swept at startup and hourly.

## Use the action

```yaml
jobs:
  build:
    runs-on: self-hosted
    permissions:
      contents: read
      id-token: write # to prove to the server which repository this is
    steps:
      - uses: actions/checkout@v6
      - run: ./build.sh
      - id: upload
        uses: fishballapp/self-hosted-artifacts/upload@v0.3.0
        with:
          server-url: http://192.0.2.10:8420
          path: dist/
      - run: curl -fO "${{ steps.upload.outputs.artifact-url }}"
```

That uploads what's in `dist/` as one zip, `artifact.zip`. To upload one file as it is, so that its
link ends in its own name, set `archive: false`:

```yaml
      - uses: fishballapp/self-hosted-artifacts/upload@v0.3.0
        with:
          server-url: http://192.0.2.10:8420
          path: dist/app.apk
          archive: false
          retention-days: 3
```

Uploading a name again works as it does with `actions/upload-artifact`: see
[One name, one artifact](#one-name-one-artifact).

| Input | Default | Meaning |
| --- | --- | --- |
| `server-url` | required | The server's base URL, as the runner reaches it. Redirects are not followed. |
| `path` | required | What to upload: see [Choosing the files](#choosing-the-files). |
| `name` | `artifact` | The name, stored as `<name>.zip`. It must pass the server's [name rule](#http-api) with `.zip` added, or the step fails with the server's message. With `archive: false` it is ignored, and the file's own name is used. |
| `overwrite` | `false` | Whether to replace an artifact this run attempt already holds under that name, rather than fail. |
| `if-no-files-found` | `warn` | With nothing to upload: `warn` writes a warning and the step succeeds, `error` fails the step, `ignore` only says so in the log. The step's outputs stay empty unless it uploaded. |
| `retention-days` | `0` | Days to keep the file. `0` means the server's default. The server caps it, and `expires-at` says what it really did. |
| `compression-level` | `6` | Zlib's level for the zip, from `0` (none) to `9` (best). For a large file that doesn't compress, `0` is much faster. |
| `include-hidden-files` | `false` | Whether to include files and folders whose names start with a `.`. |
| `archive` | `true` | Zip everything into one file. `false` uploads one file as it is, and more than one fails the step. |
| `audience` | `self-hosted-artifacts` | The OIDC audience to request. |

| Output | Meaning |
| --- | --- |
| `artifact-id` | The artifact's ID, which is also the token in its links. |
| `artifact-url` | The first link. |
| `artifact-digest` | The SHA-256 of what was uploaded, in hex. For a zip, that's the zip. |
| `links` | Every link, by label, as one-line JSON. |
| `expires-at` | When the file expires, as an ISO instant. |

Nothing is held in memory: a zip is written to a temp file in `RUNNER_TEMP`, which needs room for it,
and removed however the step ends. A network error or a 5xx is retried a few times with a short
backoff and a fresh token, since a failure here would otherwise throw away a whole build; any other
refusal fails the step at once with the server's message. A retry that finds its first try was stored
after all succeeds with that artifact.

### One name, one artifact

Within a run attempt, a name refers to one artifact, as on GitHub. The repository, run and attempt come
from the verified OIDC token, never from the request, and the repository goes by its ID, so renaming
it changes nothing.

- **A re-run starts afresh.** Attempt 2 can upload a name attempt 1 used. Both stay, each with its own
  link, until they expire.
- **Other content under a name that's taken fails the step**, with `An artifact with this name already
  exists on the workflow run`, and the first artifact stays as it was.
- **`overwrite: true` replaces it.** It gets a new ID and link, and the old link stops working as soon
  as the new one is stored. An upload that fails leaves the old artifact in place. Only that attempt's
  artifact is replaced.
- **The same content succeeds, with or without `overwrite`,** answering with the artifact already
  there, its ID, link and expiry unchanged, so a lost answer can't fail a retry.
- **Two jobs racing for a name:** one wins and the other fails as above. With `overwrite`, both succeed
  and the last one to finish is what's left.

### Choosing the files

`path` follows the rules of `actions/upload-artifact`, which come from `@actions/glob`:

```yaml
path: dist/app.apk        # a file
path: dist/               # a folder, with what's inside it
path: dist/**/*.apk       # a wildcard: *, ?, [...] and **
path: |                   # several lines add up, and the last line matching a file decides
  dist/
  logs/*.txt
  !dist/**/*.map
  # a comment, ignored
```

- **Paths** are absolute, relative to the working directory, or start with `~/`. `.` and `..` can't
  appear inside one, though `./` can start it. Brace and extended globs (`{a,b}`, `+(a)`) aren't
  wildcards here.
- **What's left off the front of the paths in a zip** depends on the patterns, and `!` lines don't
  count. With one pattern, it's the path before the first wildcard, so `dist/**/*.apk` keeps what
  follows `dist/`. A lone file sits at the top. With several, it's their nearest common ancestor, so
  `build/a` and `build/b/c.txt` give `a/...` and `b/c.txt`.
- **Hidden files** are any starting with a `.`, or inside a folder starting with one. They are left
  out unless `include-hidden-files` is `true`, even when named: `path: .env` finds nothing. A path that
  starts inside a hidden folder, like `.cache/out/`, is searched as usual.
- **Symlinks** are followed, and the zip holds what they point to. A broken one is left out.
- **A file's permissions and modified time** go into the zip, and `unzip` restores them.
- **A path in a zip** can't hold `"`, `:`, `<`, `>`, `|`, `*`, `?` or a line break, since NTFS can't
  unpack such a name. One fails the step.

### From the command line

The action wraps a command that takes the same inputs as flags, values included, and prints the
result as JSON. Repeat `--path` for several lines. The server only accepts a GitHub OIDC token, so
this works only inside a workflow's job, with `id-token: write`:

```bash
npx self-hosted-artifacts upload \
  --server-url http://192.0.2.10:8420 \
  --path dist/ --path '!dist/**/*.map' \
  --name build
```

With nothing to upload, it writes the message to stderr and prints nothing to stdout, and exits `0`
unless `--if-no-files-found` is `error`.

### Compared with `actions/upload-artifact`

File handling and retention match v7. What's left differs because the files go to your server:

| | `actions/upload-artifact` | This action |
| --- | --- | --- |
| **Inputs** | | |
| `path`, `if-no-files-found`, `include-hidden-files`, `compression-level` | | The same names, defaults and rules |
| `name` | The artifact's name, default `artifact`, without `"`, `:`, `<`, `>`, `\|`, `*`, `?`, `\`, `/` | The same default, stored as `<name>.zip`. Stricter: it must start with a letter or digit, then letters, digits, `.`, `_` or `-`, so no spaces |
| `retention-days` | 1 to 90, default 90; `0` means the default | The same by default; the server sets the default and the cap |
| `archive` | Zips by default; `false` uploads one file as it is, under its own name | The same, and that file's name must pass the rule above too |
| `overwrite` | Default `false`. Deletes an artifact of the same name, then uploads | The same default, but the old artifact goes only once the new one is stored, and an earlier attempt's is left alone |
| `server-url`, `audience` | Not applicable | Where to upload, and the OIDC audience |
| **Outputs** | | |
| `artifact-url` | Needs a GitHub login | Needs only the link, and whoever has it can download |
| `artifact-id` | A number, for GitHub's API | A string, the same token as in the link |
| `artifact-digest` | SHA-256 in hex | The same, checked by the server as it stores the file |
| `links`, `expires-at` | No | Every link by label, and when the file expires |
| **Behaviour** | | |
| Where files go | GitHub, against your plan's storage quota | A disk you own; 2 GiB per upload by default |
| Which repositories | Any | Private ones of one owner; public repositories' artifacts are free on GitHub |
| Runners | Any | Linux and macOS. `path` isn't read the Windows way |
| Job permission | None to add | `id-token: write` |
| Names | One artifact per name in a run attempt | The same, and names differing only in case are two artifacts |
| The same name and content again | Fails, unless `overwrite` | Succeeds with the artifact already there, so a retry is safe |
| Zipping | Streams to GitHub | Writes a temp file first, so `RUNNER_TEMP` needs room for the zip |
| Getting a file | `actions/download-artifact`, the run's page, the API | `curl` or a browser; it isn't listed anywhere |
| Deleting early | The run's page or the API | No: it stays until it expires |

## Versions

The server and the action are released together under one version, which follows
[semantic versioning](https://semver.org). Pin the action to a version tag, as above.

Use the same minor version of both, so action `v0.3.x` with server `0.3.x`. A new minor version may
change what they expect of each other.

## HTTP API

`POST /artifacts?name=<filename>` with `Authorization: Bearer <OIDC token>`, `Content-Length` and the
raw bytes as the body. Auth is checked before any of the body is read. Optional parameters:

| Parameter | Meaning |
| --- | --- |
| `retention-days` | Days to keep the file. The server caps it. |
| `digest` | The body's SHA-256, in 64 lowercase hex characters. The server checks it while storing. If the name is already held, it can answer without reading the body. |
| `overwrite` | `true` to replace an artifact the run attempt holds under this name. |

```json
{
  "id": "<token>",
  "name": "app.apk",
  "size": 123,
  "digest": "<sha-256>",
  "expiresAt": "2030-01-08T12:00:00Z",
  "links": { "home": "http://192.0.2.10:8420/<token>/app.apk" }
}
```

| Status | Meaning |
| --- | --- |
| `200` | The run attempt already holds this name with this content. The answer is that artifact, unchanged, whatever `overwrite` says. |
| `201` | Stored. |
| `400` | Bad name, retention, digest or overwrite. A name matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$`; nothing is sanitised. |
| `401` | Token rejected. The server's log says why. |
| `409` | The run attempt already holds this name with other content, and `overwrite` isn't `true`. |
| `411` | No `Content-Length`. |
| `413` | Over `maxFileGiB`. |
| `422` | The body doesn't match `digest`, and nothing was stored. |
| `500` | The upload failed, and it can't be downloaded. |
| `503` | The store is missing, or GitHub's signing keys can't be fetched. |
| `507` | The upload would cross `minFreeGiB`. |

Failures answer `{ "error": "<message>" }`.

`GET` or `HEAD /<token>/<filename>` serves the file. Anything else is `404`: `/`, `/<token>`, the
wrong filename, an expired file, and any query string. There is no listing.

`GET /healthz` is `200` when the store is there and `503` when it isn't.

## Security model

- **Who can upload:** a GitHub Actions workflow in a private repository of the configured owner.
  The token must be signed by GitHub with RS256 and carry the right issuer, audience, owner ID and
  `repository_visibility: private`, within its validity. Every upload is checked, including from
  localhost. Any private repository of that owner qualifies; there is no per-repository list.
- **Who can replace an artifact:** only a job of the same repository, run and attempt. Those come from
  the token's claims, and no request can name another scope.
- **Who can download:** anyone who has the link and can reach the server. There is no login: a link
  holds 256 random bits, so it can't be guessed, and it is meant to be shared. What keeps a file
  private is who can reach the server, so keep it on a network you trust. Plain `http` is readable by
  anyone on the path, so use `https` for a link that crosses anything you don't control. The action
  doesn't mask its outputs, so a step that uses a link prints it to the run's log.
- **What a file can do:** nothing in a browser. Downloads are `application/octet-stream`, as an
  attachment, with `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox;
  default-src 'none'`.
- **What a name can do:** nothing on disk. Files are stored under the server's own random ID, the name
  lives in metadata next to them, and the only trace of it in a path is its SHA-256.
- **What gets logged:** never the OIDC token, and only a short prefix of a download token. Uploads
  log the repository, run, attempt, name, size and digest.

## Limits

- 2 GiB per file by default, checked from `Content-Length` and counted while streaming. A zip counts
  as one file.
- Under 4 GiB per upload from the action or the command, whatever `maxFileGiB` says: Node's `fetch`
  can't send more with the right length. Files in a zip can be larger, as long as the zip isn't.
- 90 days' retention at most by default.
- One hour for a request, enough for 2 GiB at about 5 Mbit/s. A slower upload is cut off.
- Five minutes idle: a client that stops reading or sending is cut off, downloads included. A stalled
  download is cut off after 10 to 15 minutes, as Node restarts the timer while a write is pending.

## Not supported

S3 or other storage, a web UI, a download action (`curl` covers it), `Range` requests, and deleting a
file before it expires.

## License

[MIT](LICENSE)
