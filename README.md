# self-hosted-artifacts

A small file server and a GitHub Action that uploads to it, so builds from private repositories
can go to a disk you own.

GitHub's artifacts cap private storage at 500 MB on the free plan, and `actions/upload-artifact`
can't target your own server. A self-hosted runner that builds apps fills that quickly. Public
repositories' artifacts are free, so this is for private repositories only: the server refuses
uploads from anything else.

The server is a few files of TypeScript with no runtime dependencies. There is no install step and
no secret to manage: the action proves who it is with the workflow's OIDC token, and each upload
answers with an unguessable link.

## Run the server

Needs Node 26 and an existing directory to store files in.

```bash
STORE_DIR=/srv/artifacts \
OIDC_AUDIENCE=self-hosted-artifacts \
OIDC_REPOSITORY_OWNER_ID=123456 \
LINK_BASES='{"home":"http://192.0.2.10:8420"}' \
node packages/server/src/main.ts
```

Find your owner ID with `gh api users/<owner> --jq .id`, which works for an organisation too.

| Variable | Default | Meaning |
| --- | --- | --- |
| `STORE_DIR` | required | Where files live, as an absolute path. Must already exist: see below. |
| `OIDC_AUDIENCE` | required | The token audience to accept. The action's `audience` must match. |
| `OIDC_REPOSITORY_OWNER_ID` | required | The numeric ID of the user or organisation whose repositories may upload. |
| `LINK_BASES` | required | JSON object of label to base URL. Each upload answers with one link per label. |
| `HOST` | `0.0.0.0` | Address to listen on. |
| `PORT` | `8420` | Port to listen on. |
| `DEFAULT_RETENTION_DAYS` | `7` | Days to keep a file when the upload doesn't say. |
| `MAX_RETENTION_DAYS` | `30` | The cap. A larger request is clamped, and the real expiry comes back. |
| `MIN_FREE_BYTES` | 20 GiB | Refuse an upload that would leave less free space than this. |
| `MAX_FILE_BYTES` | 2 GiB | The largest file accepted. |

A missing or malformed setting stops the server at startup with a message naming it.

**The server never creates `STORE_DIR`.** On macOS, creating a directory at a volume's mount path
makes the real disk mount somewhere else, so a store that isn't there stays that way: uploads get
`503`, downloads `404`, `/healthz` `503`, and everything recovers by itself when it returns, with
no restart. The server only creates its own `tmp/` and `artifacts/` inside it.

Links come only from `LINK_BASES`, never from `Host` or `X-Forwarded-*`, so the links in a response
can't be steered by the request.

Logs go to stdout. Expired files and abandoned uploads are swept at startup and hourly.

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
        uses: fishballapp/self-hosted-artifacts/upload@main
        with:
          server-url: http://192.0.2.10:8420
          path: dist/app.apk
          retention-days: 3
      - run: curl -fO "${{ steps.upload.outputs.artifact-url }}"
```

| Input | Default | Meaning |
| --- | --- | --- |
| `server-url` | required | The server's base URL, as the runner reaches it. Redirects are not followed. |
| `path` | required | The one file to upload. |
| `name` | the path's basename | The name to store it under. |
| `retention-days` | the server's default | Days to keep the file. |
| `audience` | `self-hosted-artifacts` | The OIDC audience to request. |

| Output | Meaning |
| --- | --- |
| `artifact-url` | The first link. |
| `links` | Every link, by label, as one-line JSON. |
| `expires-at` | When the file goes, as an ISO instant. |

The file is streamed, not read into memory. A network error or a 5xx is retried a few times with a
short backoff and a fresh token, since a failure here would otherwise throw away a whole build; any
other refusal fails the step at once with the server's message.

### Compared with `actions/upload-artifact`

Not a drop-in: it takes one file, never zips it, and needs its own server. Compared with v7:

| | `actions/upload-artifact` | This action |
| --- | --- | --- |
| **Inputs** | | |
| `path` | A file, folder or wildcard pattern | One file; a folder or a missing file fails the step |
| `name` | The artifact's name, default `artifact` | The file's name, default the path's basename |
| `retention-days` | 1 to 90, default 90; `0` means the default | 1 or more, capped by the server, default set by the server; `0` is refused |
| `archive` | Zips by default; `false` uploads one file as it is | No input: never zips |
| `compression-level` | 0 to 9 | No input: never zips |
| `if-no-files-found` | `warn` by default, or `error` or `ignore` | No input: always fails |
| `overwrite` | Replaces an artifact of the same name; otherwise that fails | No input: each upload is a new file with its own link |
| `include-hidden-files` | Off by default | No input: `path` names the file. A name must start with a letter or digit, so a hidden file needs `name` |
| `server-url`, `audience` | Not applicable | Where to upload, and the OIDC audience |
| **Outputs** | | |
| `artifact-url` | Needs a GitHub login | Needs only the link, and whoever has it can download |
| `artifact-id`, `artifact-digest` | Yes | No |
| `links`, `expires-at` | No | Every link by label, and when the file goes |
| **Behaviour** | | |
| Where files go | GitHub, against your plan's storage quota | A disk you own; 2 GiB per file by default |
| Which repositories | Any | Private ones of one owner; public repositories' artifacts are free on GitHub |
| Job permission | None to add | `id-token: write` |
| Getting a file | `actions/download-artifact`, the run's page, the API | `curl` or a browser; it isn't listed anywhere |
| Deleting early | The run's page or the API | No: it stays until it expires |

## HTTP

`POST /artifacts?name=<filename>&retention-days=<n>` with `Authorization: Bearer <OIDC token>`,
`Content-Length` and the raw bytes as the body. `retention-days` is optional. Auth is checked before
any of the body is read.

```json
{
  "name": "app.apk",
  "size": 123,
  "expiresAt": "2030-01-08T12:00:00Z",
  "links": { "home": "http://192.0.2.10:8420/<token>/app.apk" }
}
```

| Status | Meaning |
| --- | --- |
| `201` | Stored. |
| `400` | Bad name or retention. A name matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$`; nothing is sanitised. |
| `401` | Token rejected. The server's log says why. |
| `411` | No `Content-Length`. |
| `413` | Over `MAX_FILE_BYTES`. |
| `503` | The store is missing, or GitHub's signing keys can't be fetched. |
| `507` | The upload would cross `MIN_FREE_BYTES`. |

Failures answer `{ "error": "<message>" }`.

`GET` or `HEAD /<token>/<filename>` serves the file. Anything else is `404`: `/`, `/<token>`, the
wrong filename, an expired file, and any query string. There is no listing.

`GET /healthz` is `200` when the store is there and `503` when it isn't.

## Security model

- **Who can upload:** a GitHub Actions workflow in a private repository of the configured owner.
  The token must be signed by GitHub with RS256 and carry the right issuer, audience, owner ID and
  `repository_visibility: private`, within its validity. Every upload is checked, including from
  localhost. Any private repository of that owner qualifies; there is no per-repository list.
- **Who can download:** anyone who has the link and can reach the server. A link holds 256 random
  bits, so it can't be guessed, but it is the only credential: treat it as a secret, and keep the
  server on a network you trust. Plain `http` is readable by anyone on the path, so use `https` for
  a link that crosses anything you don't control. The action doesn't mask its outputs, so a step
  that uses a link prints it to the run's log, where anyone who can read the log can use it.
- **What a file can do:** nothing in a browser. Downloads are `application/octet-stream`, as an
  attachment, with `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox;
  default-src 'none'`.
- **What a name can do:** nothing on disk. Files are stored under the server's own random ID, and
  the name lives in metadata next to them.
- **What gets logged:** never the OIDC token, and only a short prefix of a download token. Uploads
  log the repository, name and size.

## Limits

- 2 GiB per file by default, checked from `Content-Length` and counted while streaming.
- 30 days' retention at most by default.
- One hour for a request, enough for 2 GiB at about 5 Mbit/s. A slower upload is cut off.
- Five minutes idle: a client that stops reading or sending is cut off, downloads included. A stalled
  download goes at 10 to 15 minutes, as Node restarts the timer while a write is pending.

## Not in version 1

A web UI, S3 or other storage, a download action (`curl` covers it), folders, `Range` requests,
deleting a file before it expires.
