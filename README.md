# self-hosted-artifacts

**Keep your GitHub Actions artifacts on a disk or in a bucket you own.** GitHub Actions that upload,
download and merge artifacts, against either a small file server or S3 and anything S3-compatible,
with no server at all.

GitHub's artifacts cap private storage at 500 MB on the free plan, which a few app builds fill, and
`actions/upload-artifact` can't target your own storage. These actions take the same inputs by the
same rules as `actions/upload-artifact`, `actions/upload-artifact/merge` and
`actions/download-artifact`, so moving to them means changing the `uses:` lines and saying where
artifacts go.

| | [A server](#run-the-server) | [A bucket](#use-a-bucket) |
| --- | --- | --- |
| **You run** | A process on a machine with a disk | Nothing |
| **Say where with** | `server-url` | `s3-bucket`, `s3-link-base`, a region, and `s3-endpoint` off AWS |
| **What proves who a job is** | The workflow's OIDC token, with `id-token: write`, so no secrets | The bucket's credentials, in the job's environment |
| **Which repositories** | Private ones of one owner | Any job with the credentials |
| **Who can read a link** | Anyone who has it and can reach the server | Anyone who has it, from anywhere |
| **Expired files** | Swept hourly | Removed at the next upload, and by a lifecycle rule you add |

- **No dependencies.** The server installs from npm as one package, and the actions run as they are.
- **No account to download.** Each upload also answers with an unguessable link that works with
  `curl` or a browser, and expires by itself.

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

`oidcRepositoryOwnerId` is the user or organisation whose repositories may use the server. Find it with
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
| `oidcRepositoryOwnerId` | required | The numeric ID of the user or organisation whose repositories may use the server. |
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
when it mounts. While the store is missing, uploads, listing and deleting get `503`, links `404` and
`/healthz` `503`, and everything recovers by itself when it returns, with no restart. The server only
creates its own `tmp/`, `artifacts/`, `runs/` and `repositories/` inside it.

**Run one server per store, on a disk with hard links** (APFS, ext4 or XFS, say; not exFAT). A name is
a hard link to its artifact's metadata, and uploads and deletes take turns inside the server's process.

Links come only from `linkBases`, never from `Host` or `X-Forwarded-*`, so the links in a response
can't be steered by the request.

Logs go to stdout in logfmt. Expired files and abandoned uploads are swept at startup and hourly.

## Use a bucket

Give each step `s3-bucket` rather than `server-url`, and the rest of this README holds: the same
inputs, names, attempts, retries and digests. Exactly one of the two, or the step fails. Nothing
needs to run, and the server has no part in it.

| Input | Default | Meaning |
| --- | --- | --- |
| `s3-bucket` | | The bucket. Instead of `server-url`. |
| `s3-link-base` | required with `s3-bucket` | What `artifact-url` starts with: `<s3-link-base>/artifacts/<id>/<name>`. See your store's setup below. |
| `s3-region` | `AWS_REGION` | The bucket's region. On R2, `auto`. |
| `s3-endpoint` | AWS | The endpoint of anything else that speaks S3, such as R2 or MinIO. Requests then use path-style addressing, and without it virtual-hosted. |

The credentials are the standard variables, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and, with
temporary ones, `AWS_SESSION_TOKEN`. There is no input for them, and nothing prints them. They need
`s3:GetObject`, `s3:PutObject` and `s3:DeleteObject` on the bucket's objects, and `s3:ListBucket` on
the bucket, without which a missing object reads as `403` and every first upload fails.

Which run a job belongs to comes from `GITHUB_REPOSITORY_ID`, `GITHUB_RUN_ID` and `GITHUB_RUN_ATTEMPT`.
Outside Actions, [`--scope`](#from-the-command-line) gives the same.

The store has to honour conditional writes, as AWS, R2 and MinIO do: see
[what's been tried](#whats-been-tried). Read the [security model](#with-a-bucket) before you make a
bucket public.

### On AWS

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write # for aws-actions/configure-aws-credentials, not for these actions
    steps:
      - uses: actions/checkout@v6
      - uses: aws-actions/configure-aws-credentials@v5
        with:
          role-to-assume: arn:aws:iam::123456789012:role/artifacts
          aws-region: eu-west-2
      - run: ./build.sh
      - id: upload
        uses: fishballapp/self-hosted-artifacts/upload@v0.6.0
        with:
          s3-bucket: YOUR-BUCKET
          s3-link-base: https://YOUR-BUCKET.s3.eu-west-2.amazonaws.com
          path: dist/
      - run: curl -fO "${{ steps.upload.outputs.artifact-url }}"
```

A link is an anonymous read, so this bucket has to allow them, on those keys and nothing else. Use a
bucket for this alone, with versioning off, since a deleted version would still be stored.

1. Turn off the two parts of the bucket's public-access block that refuse a public policy. Leave the
   two about ACLs on, as nothing here uses one. If your account has a block of its own, that has to
   allow it too.

   ```bash
   aws s3api put-public-access-block --bucket YOUR-BUCKET --public-access-block-configuration \
     BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=false,RestrictPublicBuckets=false
   ```

2. Add this bucket policy: anonymous `GetObject` on `artifacts/*` only. It gives no anonymous listing,
   and nothing else in the bucket is public.

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Sid": "AnonymousLinks",
         "Effect": "Allow",
         "Principal": "*",
         "Action": "s3:GetObject",
         "Resource": "arn:aws:s3:::YOUR-BUCKET/artifacts/*"
       }
     ]
   }
   ```

3. Add one lifecycle rule across the bucket, at the longest retention you use, 90 days at most. This
   is the backstop: see [Expiry](#expiry-with-a-bucket).

   ```bash
   aws s3api put-bucket-lifecycle-configuration --bucket YOUR-BUCKET --lifecycle-configuration \
     '{"Rules":[{"ID":"artifacts","Status":"Enabled","Filter":{},"Expiration":{"Days":90}}]}'
   ```

A bucket whose name holds a dot doesn't match S3's TLS certificate when virtual-hosted. Set
`s3-endpoint: https://s3.<region>.amazonaws.com` to use path style.

### On R2

```yaml
      - id: upload
        uses: fishballapp/self-hosted-artifacts/upload@v0.6.0
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
        with:
          s3-bucket: YOUR-BUCKET
          s3-region: auto
          s3-endpoint: https://<ACCOUNT_ID>.r2.cloudflarestorage.com
          s3-link-base: https://files.example.com
          path: dist/
```

R2 has no bucket policy that could open one prefix: public access is the whole bucket. An artifact's
metadata sits in that bucket under a key that can be worked out from a repository's ID, a run's ID and
the artifact's name, and it holds the artifact's ID, which is its link. So on R2 the rule below **is**
what keeps `runs/` and `repositories/` from being read, and it needs a custom domain.

1. Connect a [custom domain](https://developers.cloudflare.com/r2/buckets/public-buckets/) to the bucket,
   and leave the `r2.dev` URL off, which no rule can cover. `s3-link-base` is that domain.
2. Add a WAF custom rule on the domain's zone that blocks everything else, with the expression
   `(http.host eq "files.example.com" and not starts_with(http.request.uri.path, "/artifacts/"))`.
3. Add a cache rule on that host that bypasses the cache. Cloudflare caches `.zip`, `.apk` and other
   file types by default, so a deleted or replaced artifact's link would otherwise keep working for
   up to two hours.
4. Add one [object lifecycle rule](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
   across the bucket that deletes objects after your longest retention, 90 days at most.

Create an R2 API token with **Object Read & Write** on this bucket for the credentials.

### One artifact, in the bucket

```
artifacts/<id>/<name>                                     the file, with Content-Type: application/octet-stream
                                                          and Content-Disposition: attachment
runs/<repository_id>/<run_id>/<run_attempt>/<sha256(name)>.json
                                                          what makes it exist: its metadata
repositories/<sha256(lower-case owner/name)>.json         a repository's ID, from its name
```

`id` is 256 random bits, as a server's download token is. Looking up a name is one key and listing a
run is one prefix. The steps read through signed requests, never through the links, so they don't care
what's in front of `s3-link-base`.

### Expiry with a bucket

There's no sweeper, so:

- **Every read respects `expiresAt` in the metadata.** An expired artifact isn't listed, downloaded,
  merged or deleted, and its name is free again.
- **Each upload removes what has expired for its own repository,** best-effort, looking at up to 100
  names for up to 3 seconds. It can't fail the upload.
- **The lifecycle rule is the backstop,** for a repository that stops uploading and for what a crash
  leaves. Without it, those stay and you pay to store them.

Retention defaults to 90 days, and 90 is the most. **So an expired link can keep working until the next
upload of that repository or that rule removes it,** for up to the rule's age. If it mustn't, delete
the artifact rather than let it expire.

### What's been tried

The tests run against MinIO in a container, as well as a small fake. AWS and R2 are from their docs, not
yet from a run: conditional writes on both, and on R2 whether `x-amz-checksum-sha256` refuses a body
that doesn't match. If it doesn't, a body damaged on its way up is only found at download, by the digest
check.

## Upload

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
        uses: fishballapp/self-hosted-artifacts/upload@v0.6.0
        with:
          server-url: http://192.0.2.10:8420
          path: dist/
      - run: curl -fO "${{ steps.upload.outputs.artifact-url }}"
```

That uploads what's in `dist/` as one zip, `artifact.zip`. To upload one file as it is, so that its
link ends in its own name, set `archive: false`:

```yaml
      - uses: fishballapp/self-hosted-artifacts/upload@v0.6.0
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
| `server-url` | | The server's base URL, as the runner reaches it. Redirects are not followed. Give this or [`s3-bucket` and what goes with it](#use-a-bucket). |
| `path` | required | What to upload: see [Choosing the files](#choosing-the-files). |
| `name` | `artifact` | The name, stored as `<name>.zip`. It must pass the [name rule](#http-api) with `.zip` added, or the step fails saying so. With `archive: false` it is ignored, and the file's own name is used. |
| `overwrite` | `false` | Whether to replace an artifact this run attempt already holds under that name, rather than fail. |
| `if-no-files-found` | `warn` | With nothing to upload: `warn` writes a warning and the step succeeds, `error` fails the step, `ignore` only says so in the log. The step's outputs stay empty unless it uploaded. |
| `retention-days` | `0` | Days to keep the file. `0` means the default, which is the server's, or 90 with a bucket. A larger number is capped, and `expires-at` says what really happened. |
| `compression-level` | `6` | Zlib's level for the zip, from `0` (none) to `9` (best). For a large file that doesn't compress, `0` is much faster. |
| `include-hidden-files` | `false` | Whether to include files and folders whose names start with a `.`. |
| `archive` | `true` | Zip everything into one file. `false` uploads one file as it is, and more than one fails the step. |
| `audience` | `self-hosted-artifacts` | With `server-url`, the OIDC audience to request. |

| Output | Meaning |
| --- | --- |
| `artifact-id` | The artifact's ID, which is also the token in its links. |
| `artifact-url` | The first link. |
| `artifact-digest` | The SHA-256 of what was uploaded, in hex. For a zip, that's the zip. |
| `links` | Every link, by label, as one-line JSON. With a bucket, the one label is `s3`. |
| `expires-at` | When the file expires, as an ISO instant. |

Nothing is held in memory: a zip is written to a temp file in `RUNNER_TEMP`, which needs room for it,
and removed however the step ends. A network error or a 5xx is retried a few times with a short
backoff and a fresh token or signature, since a failure here would otherwise throw away a whole build;
any other refusal fails the step at once with the target's message. A retry that finds its first try
was stored after all succeeds with that artifact.

### One name, one artifact

Within a run attempt, a name refers to one artifact, as on GitHub. The repository goes by its ID, so
renaming it changes nothing. With a server, the repository, run and attempt come from the verified OIDC
token, never from the request. With a bucket, they come from the job's variables, which nothing verifies:
the credentials are the trust boundary.

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

### Compared with `actions/upload-artifact`

File handling and retention match v7. What's left differs because the files go to your server or bucket:

| | `actions/upload-artifact` | This action |
| --- | --- | --- |
| **Inputs** | | |
| `path`, `if-no-files-found`, `include-hidden-files`, `compression-level` | | The same names, defaults and rules |
| `name` | The artifact's name, default `artifact`, without `"`, `:`, `<`, `>`, `\|`, `*`, `?`, `\`, `/` | The same default, stored as `<name>.zip`. Stricter: it must start with a letter or digit, then letters, digits, `.`, `_` or `-`, so no spaces |
| `retention-days` | 1 to 90, default 90; `0` means the default | The same by default; a server sets its own default and cap |
| `archive` | Zips by default; `false` uploads one file as it is, under its own name | The same, and that file's name must pass the rule above too |
| `overwrite` | Default `false`. Deletes an artifact of the same name, then uploads | The same default, but the old artifact goes only once the new one is stored, and an earlier attempt's is left alone |
| `server-url`, `audience` or `s3-bucket`, `s3-region`, `s3-endpoint`, `s3-link-base` | Not applicable | Where to upload |
| **Outputs** | | |
| `artifact-url` | Needs a GitHub login | Needs only the link, and whoever has it can download |
| `artifact-id` | A number, for GitHub's API | A string, the same token as in the link |
| `artifact-digest` | SHA-256 in hex | The same, checked as the file is stored |
| `links`, `expires-at` | No | Every link by label, and when the file expires |
| **Behaviour** | | |
| Where files go | GitHub, against your plan's storage quota | A disk you own, 2 GiB per upload by default, or a bucket, under 4 GiB per upload |
| Which repositories | Any | With a server, private ones of one owner, as public repositories' artifacts are free on GitHub. With a bucket, any job with the credentials |
| Runners | Any | Linux and macOS. `path` isn't read the Windows way |
| Job permission | None to add | With a server, `id-token: write`. With a bucket, credentials in the environment |
| Names | One artifact per name in a run attempt | The same, and names differing only in case are two artifacts |
| The same name and content again | Fails, unless `overwrite` | Succeeds with the artifact already there, so a retry is safe |
| Zipping | Streams to GitHub | Writes a temp file first, so `RUNNER_TEMP` needs room for the zip |
| Getting a file | `actions/download-artifact`, the run's page, the API | [The download action](#download), or `curl` or a browser with the link |
| Deleting early | The run's page or the API | [`delete` on the command line](#from-the-command-line), for that repository |

## Download

```yaml
jobs:
  deploy:
    needs: build
    runs-on: self-hosted
    permissions:
      id-token: write # to prove to the server which repository this is
    steps:
      - id: download
        uses: fishballapp/self-hosted-artifacts/download@v0.6.0
        with:
          server-url: http://192.0.2.10:8420
          name: build
          path: out
      - run: ls -R "${{ steps.download.outputs.download-path }}"
```

| Input | Default | Meaning |
| --- | --- | --- |
| `server-url` | | The server's base URL, as the runner reaches it. Files come from here, not from a link's base, which may be one only people can reach. Redirects are not followed. Give this or [`s3-bucket` and what goes with it](#use-a-bucket). |
| `name` | every artifact | The artifact to download. `build` finds the zip `build.zip`; failing that, a file of exactly that name, such as `app.apk`, which is how one uploaded with `archive: false` is named. Fails if there is neither. |
| `artifact-ids` | | The IDs to download, comma-separated, from an upload's `artifact-id` output. Can't go with `name`. Fails if none is found, and warns about any that isn't. |
| `path` | `$GITHUB_WORKSPACE` | Where they go. It can start with `~`, and is made if it isn't there. |
| `pattern` | | A glob the artifacts' names must match. Ignored with `name` or `artifact-ids`. Matching nothing isn't a failure. |
| `merge-multiple` | `false` | Whether several artifacts share `path`, rather than taking a folder each. They unpack one at a time in name order, so the last wins a path they both hold. |
| `github-token` | | Accepted and ignored, with a note saying so, so a workflow moving over needn't change. |
| `repository` | the job's | Which repository to read, as `owner/name`, in any case. |
| `run-id` | the job's | Which run to read. |
| `skip-decompress` | `false` | Whether to keep a zip as it is, rather than unpacking it. |
| `digest-mismatch` | `error` | What to do when a file's SHA-256 isn't what was stored with it: `ignore`, `info`, `warn` or `error`. With `error`, that artifact isn't unpacked, the rest still download, and the step fails naming each one that didn't match. |
| `audience` | `self-hosted-artifacts` | With `server-url`, the OIDC audience to request. |

| Output | Meaning |
| --- | --- |
| `download-path` | The absolute path it all went to. |

```
path/                       one artifact, by name, by ID or as the only match of a pattern
  ...its files
path/build/...              several artifacts: a folder each, named as they were uploaded
path/other/...
path/...all of them         several, with merge-multiple
path/app.apk                a file uploaded with archive: false; among several, path/app.apk/app.apk
path/build.zip              with skip-decompress; among several, path/build/build.zip
```

- **`repository` and `run-id` work alone or together.** Each takes the job's own when left out, so
  `run-id` alone reads another run of this repository, and `repository` alone looks in this run's
  number over there, which finds nothing. With a server, reading works across the private repositories
  of its owner, and with a bucket across every repository in it. A repository can be found by name once
  it has uploaded with this version, in a job rather than with `--scope`.
- **Across attempts, the latest wins.** For each name in a run, a read takes the latest attempt that
  holds it, as upstream's list with `latest` does. So an earlier attempt's ID isn't found once a later
  attempt holds its name, and a name only an earlier attempt holds is still found.
- **A file name is what's stored.** What ends in `.zip` is unpacked; anything else is written
  as that file, with `644`. A folder's name and what `pattern` matches leave off the `.zip`.
- **Nothing is held in memory.** Each file streams to a temp file in `RUNNER_TEMP`, which needs room
  for it. Its size and SHA-256 are checked there, and only then is it unpacked or moved, so a
  mismatch with `error` leaves nothing behind. The temp file goes however the step ends. A network
  error, a 5xx or a body cut short is retried a few times; any other refusal fails the step at once.
- **A zip can't write outside its folder.** Every entry is checked before the first is written, and
  a path that leads out, an absolute path or any symlink fails the step with nothing written. The same
  goes for a symlink out that the destination already holds, in a folder an entry goes through. Where
  a file goes, one already there is replaced, symlink or not, and never followed. If a zip you trust holds
  symlinks, set `skip-decompress` and unpack it yourself.
- **A zip bomb can't fill the disk.** What the entries declare has to fit in the free space, whatever
  their ratio, and an entry that gives more than it declared fails the step.
- **Permissions in a zip are restored,** without the setuid, setgid and sticky bits. Modified times aren't.

### Compared with `actions/download-artifact`

Inputs, layout and messages match v8. What's left differs because the files come from your server or
bucket:

| | `actions/download-artifact` | This action |
| --- | --- | --- |
| **Inputs** | | |
| `name`, `path`, `pattern`, `merge-multiple`, `skip-decompress`, `digest-mismatch` | | The same names, defaults and rules |
| `artifact-ids` | Numbers, for GitHub's API | The strings an upload's `artifact-id` outputs |
| `github-token` | What lets it read another run or repository | Accepted and ignored: the job's OIDC token, or the bucket's credentials, is enough |
| `repository`, `run-id` | Ignored without `github-token` | Read with or without it |
| `server-url`, `audience` or `s3-bucket`, `s3-region`, `s3-endpoint`, `s3-link-base` | Not applicable | Where to read from |
| **Behaviour** | | |
| Which repositories | Any the token can read | With a server, private ones of one owner, without a token to manage. With a bucket, any in it |
| Runners | Any | Linux and macOS |
| Job permission | None to add for this run; `actions: read` on a token elsewhere | With a server, `id-token: write`. With a bucket, credentials in the environment |
| Unpacking | Streams, so a bad digest is only known after unpacking | A temp file first, so `RUNNER_TEMP` needs room, and a bad digest with `error` unpacks nothing |
| `merge-multiple` with a path two artifacts hold | Whichever finished last, as five download at once | The last in name order, every time |
| Permissions in a zip | Lost: `644` and `755` | Restored, without the setuid, setgid and sticky bits |
| Symlinks in a zip | Written as a file holding the target | Refused, with nothing written |
| A zip that declares more than the disk has | Fails when the disk fills | Fails before writing anything |

## Merge

Combines the artifacts of a run into one, as `actions/upload-artifact/merge` does. It downloads the
matching artifacts, uploads what they hold as one, and can delete them once that is stored.

```yaml
jobs:
  merge:
    needs: build
    runs-on: self-hosted
    permissions:
      id-token: write # to prove to the server which repository this is
    steps:
      - id: merge
        uses: fishballapp/self-hosted-artifacts/upload/merge@v0.6.0
        with:
          server-url: http://192.0.2.10:8420
          name: all-builds
          pattern: build-*
          delete-merged: true
      - run: curl -fO "${{ steps.merge.outputs.artifact-url }}"
```

With no inputs but where artifacts are, every artifact of the run becomes one called `merged-artifacts`,
which is stored as `merged-artifacts.zip`.

| Input | Default | Meaning |
| --- | --- | --- |
| `server-url` | | The server's base URL, as the runner reaches it. Redirects are not followed. Give this or [`s3-bucket` and what goes with it](#use-a-bucket). |
| `name` | `merged-artifacts` | The name of the merged artifact, stored as `<name>.zip`. It must pass the [name rule](#http-api) with `.zip` added. |
| `pattern` | `*` | A glob the artifacts' names must match, without their `.zip`, as in [the download action](#download). |
| `separate-directories` | `false` | Whether each artifact goes in a folder of its name in the merged zip, rather than all in the root. |
| `retention-days` | `0` | Days to keep the merged artifact. `0` means the default, as for [an upload](#upload). A larger number is capped. |
| `compression-level` | `6` | Zlib's level for the merged zip, from `0` (none) to `9` (best). |
| `delete-merged` | `false` | Whether to delete the merged artifacts once the merged one is stored. |
| `include-hidden-files` | `false` | Whether the merged zip holds files and folders whose names start with a `.`. |
| `audience` | `self-hosted-artifacts` | With `server-url`, the OIDC audience to request. |

| Output | Meaning |
| --- | --- |
| `artifact-id` | The merged artifact's ID, which is also the token in its links. |
| `artifact-url` | Its first link. |
| `artifact-digest` | The SHA-256 of its zip, in hex. |
| `links` | Every link, by label, as one-line JSON. |
| `expires-at` | When it expires, as an ISO instant. |

- **It reads this run only,** each name's latest attempt, as `actions/download-artifact` lists it.
  Nothing matching the `pattern` fails the step, with `No artifacts found matching pattern '<pattern>'`.
- **The merged artifact is never one of its own inputs.** A re-run's `*` would otherwise take in the
  attempt before's `<name>.zip`, and `delete-merged` would delete it. Another artifact of any other
  name that the pattern matches is merged as usual.
- **Layout:** with `separate-directories: false`, they unpack one at a time in name order into one
  folder, so the last wins a path they both hold. With `true`, each goes in a folder of its name, even
  when only one matches. A file uploaded with `archive: false` is a file `app.apk` in the root, or in
  `app.apk/app.apk`. Then `include-hidden-files` decides what the new zip takes, so with `false`, a
  hidden file in an artifact is left out of the merged one.
- **Each artifact's digest is checked** as [the download action's](#download) `digest-mismatch: error`
  does. A mismatch fails the step with nothing uploaded and nothing deleted.
- **Originals go last.** A failure at any step before the merged artifact is stored, a refused upload
  included, leaves every one in place. Then each is deleted, five at a time. If any delete fails, the
  step fails naming each one, though the merged artifact stays and the outputs are already set.
  Deleting is held to the job's own repository, as [the `delete` command](#from-the-command-line) is.
- **Merging again** is [a name in a run attempt](#one-name-one-artifact) like any other. A re-run holds
  `<name>.zip` afresh, and leaves the attempt before's alone. Within one attempt, the same files merge
  to the same zip, since every file in it is stamped 1980-01-01, so a step that runs twice, or is
  retried after a delete failed, succeeds with the artifact already there and goes on to delete. Other
  content under the name fails the step as an upload would. If a delete failed part-way, the rest are
  fewer, so merging again fails this way: delete what's left with `delete`.
- **Nothing is held in memory,** but the runner's temp folder holds every artifact unpacked, then the
  merged zip, and removes them however the step ends. `RUNNER_TEMP` needs room for both. The merged zip
  counts as one file towards [the limits](#limits).

### Compared with `actions/upload-artifact/merge`

Inputs, outputs, defaults and messages match v7. What's left differs because the files go to your
server or bucket:

| | `actions/upload-artifact/merge` | This action |
| --- | --- | --- |
| **Inputs** | | |
| `name`, `pattern`, `separate-directories`, `retention-days`, `compression-level`, `delete-merged`, `include-hidden-files` | | The same names and defaults |
| `name` | Without `"`, `:`, `<`, `>`, `\|`, `*`, `?`, `\`, `/` | Stored as `<name>.zip`, and stricter: see [Upload](#upload) |
| `server-url`, `audience` or `s3-bucket`, `s3-region`, `s3-endpoint`, `s3-link-base` | Not applicable | Where to read and write |
| **Outputs** | | |
| `artifact-id`, `artifact-url`, `artifact-digest` | A number, a URL that needs a GitHub login, SHA-256 in hex | A string, a link anyone can use, and the same digest |
| `links`, `expires-at` | No | Every link by label, and when it expires |
| **Behaviour** | | |
| Which artifacts | The pattern alone | The pattern, less the merged artifact's own name |
| Downloads | Five at once, so a path two artifacts hold goes to whichever finished last | One at a time, in name order |
| Digest of a download | Not checked | Checked, and a mismatch fails the step with nothing uploaded |
| Deleting | By name, all at once, after the upload | By ID, five at a time, after the upload, and each is tried |
| Where it unpacks | A folder in the working directory | A folder in `RUNNER_TEMP`, removed however the step ends |
| Merging again in a run attempt | Fails | The same files succeed; other content fails |
| A bad input | Fails once the rest has run | Fails before anything is downloaded |
| Which repositories | Any | With a server, private ones of one owner. With a bucket, any job with the credentials |
| Runners | Any | Linux and macOS |
| Job permission | None to add | With a server, `id-token: write`. With a bucket, credentials in the environment |

## From the command line

The actions wrap commands that take the same inputs as flags, values included, and print the result
as JSON. A server only accepts a GitHub OIDC token, so against one these work only inside a workflow's
job, with `id-token: write`. Against a bucket they work anywhere with the credentials: outside Actions,
`--scope <repository ID>/<run ID>/<run attempt>`, each a number, says which run this is, and wins over
the job's variables. Anything else they have to say goes to stderr.

```bash
# As the upload action. Repeat --path for several lines.
npx self-hosted-artifacts upload \
  --server-url http://192.0.2.10:8420 \
  --path dist/ --path '!dist/**/*.map' \
  --name build

# As the download action.
npx self-hosted-artifacts download --server-url http://192.0.2.10:8420 --name build --path out

# Each name's latest in a run, narrowed by --name, --artifact-ids or --pattern, from this run unless
# --repository or --run-id say otherwise.
npx self-hosted-artifacts list --server-url http://192.0.2.10:8420 --pattern 'build-*'

# One artifact of this job's repository: by name in this run, or by ID in any run.
npx self-hosted-artifacts delete --server-url http://192.0.2.10:8420 --name build
npx self-hosted-artifacts delete --server-url http://192.0.2.10:8420 --artifact-id "$ID"

# As the merge action. It prints the merged artifact, and what went into it, before it deletes.
npx self-hosted-artifacts merge \
  --server-url http://192.0.2.10:8420 \
  --pattern 'build-*' --name all-builds --delete-merged true

# Any of them against a bucket, from your own machine.
AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... npx self-hosted-artifacts list \
  --s3-bucket YOUR-BUCKET --s3-region eu-west-2 \
  --s3-link-base https://YOUR-BUCKET.s3.eu-west-2.amazonaws.com \
  --scope 123456/987654/1
```

With nothing to upload, `upload` writes the message to stderr and prints nothing to stdout, and exits
`0` unless `--if-no-files-found` is `error`. There is no delete action, as upstream has none.

An upload with `--scope` knows a repository only by its ID, so it records no name for it, and a
`--repository owner/name` finds it only once a job of that repository has uploaded.

## Versions

The server and the action are released together under one version, which follows
[semantic versioning](https://semver.org). Pin the action to a version tag, as above.

Use the same minor version of both, so action `v0.6.x` with server `0.6.x`. A new minor version may
change what they expect of each other. Nothing about a bucket involves the server, so a bucket has only
the action's version to pin, and what it holds is read by every later action of the same minor version.

## HTTP API

This is the server's. A bucket has its own layout: see [One artifact, in the bucket](#one-artifact-in-the-bucket).

Every route but a file's and `/healthz` takes `Authorization: Bearer <OIDC token>`, checked first:
`401` if it's rejected, whose reason is in the server's log, and `503` if GitHub's signing keys can't
be fetched. Failures answer `{ "error": "<message>" }`. While the store is missing, these routes
answer `503` too.

### Storing a file

`POST /artifacts?name=<filename>` with `Content-Length` and the raw bytes as the body. Auth is checked
before any of the body is read. Optional parameters:

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
| `409` | The run attempt already holds this name with other content, and `overwrite` isn't `true`. |
| `411` | No `Content-Length`. |
| `413` | Over `maxFileGiB`. |
| `422` | The body doesn't match `digest`, and nothing was stored. |
| `500` | The upload failed, and it can't be downloaded. |
| `507` | The upload would cross `minFreeGiB`. |

### Listing a run

`GET /artifacts` answers with each name's latest artifact in a run, in name order, from the latest
attempt that holds it, leaving out what has expired. Any private repository of the owner can read any
other's. Optional parameters:

| Parameter | Meaning |
| --- | --- |
| `repository` | `owner/name`, in any case. Defaults to the token's. A repository that has never uploaded holds nothing. |
| `run-id` | Defaults to the token's run. |
| `name` | Repeatable. Only these exact stored names, each looked up directly. |
| `id` | Repeatable, and not with `name`. Only these IDs, among what the repository and run hold. |

```json
{
  "artifacts": [
    {
      "id": "<token>",
      "name": "app.apk",
      "size": 123,
      "digest": "<sha-256>",
      "expiresAt": "2030-01-08T12:00:00Z",
      "links": { "home": "http://192.0.2.10:8420/<token>/app.apk" },
      "repositoryId": "7",
      "runId": "100",
      "runAttempt": "2"
    }
  ]
}
```

`200` even when nothing matches; `400` for a bad `repository`, `run-id` or `id`, or `id` with `name`.

### Deleting an artifact

`DELETE /artifacts/<id>` removes an artifact and its name together, and its link stops at once. The
ID must belong to the token's own repository, in any of its runs. It answers `{ "id": "<id>", "name":
"<filename>" }`, `403` for another repository's, and `404` for one that isn't there, has expired or was
replaced.

### Everything else

`GET` or `HEAD /<token>/<filename>` serves the file, and needs no token. Anything else is `404`: `/`,
`/<token>`, the wrong filename, an expired file, and any query string.

`GET /healthz` is `200` when the store is there and `503` when it isn't.

## Security model

The two targets draw the line in different places. Read the one you use.

### With a server

- **Who can upload:** a GitHub Actions workflow in a private repository of the configured owner.
  The token must be signed by GitHub with RS256 and carry the right issuer, audience, owner ID and
  `repository_visibility: private`, within its validity. Every request is checked, including from
  localhost. Any private repository of that owner qualifies; there is no per-repository list.
- **Who can list:** a workflow that passes the same check, for any private repository of that owner.
  One owner is the trust boundary, and what a list gives is links, which aren't credentials anyway.
- **Who can replace an artifact:** only a job of the same repository, run and attempt. Those come from
  the token's claims, and no request can name another scope.
- **Who can delete an artifact:** only a job of the same repository, by the `repository_id` claim, in
  any run. Another repository of the owner gets a `403`, so a read across repositories can't become a
  write. A merge deletes only what it lists in its own run, by those rules.
- **Who can download:** anyone who has the link and can reach the server. There is no login: a link
  holds 256 random bits, so it can't be guessed, and it is meant to be shared. What keeps a file
  private is who can reach the server, so keep it on a network you trust. Plain `http` is readable by
  anyone on the path, so use `https` for a link that crosses anything you don't control. The action
  doesn't mask its outputs, so a step that uses a link prints it to the run's log.
- **What a file can do:** nothing in a browser. Downloads are `application/octet-stream`, as an
  attachment, with `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox;
  default-src 'none'`.
- **What a name can do:** nothing on disk. Files are stored under the server's own random ID, the name
  lives in metadata next to them, and the only trace of it in a path is its SHA-256. A repository's
  name is the same, as `repository` could otherwise walk the store, and `run-id` is digits only.
- **What a zip can do to a runner:** nothing outside its folder. See [Download](#download). The client
  holds a server's answers to the server's own rules too, so a name or ID that could lead out of
  the destination fails the step.
- **What gets logged:** never the OIDC token, and only a short prefix of a download token. Uploads
  log the repository, run, attempt, name, size and digest. The download action prints each artifact's
  ID in the run's log, as the upload action's outputs print its links.

### With a bucket

- **Anyone with the bucket's credentials can read, overwrite or delete anything in it.** They are the
  whole trust boundary. The server's checks don't exist here: no private-repository check, no owner
  check, and nothing verifies which job is asking. A job says which repository, run and attempt it is,
  through its variables, and could say anything. Every repository sharing a bucket trusts every other,
  so use a bucket per trust boundary, and keep the credentials to the jobs that need them. What holds a
  job to deleting only its own repository's artifacts, and to only replacing its own attempt's, is this
  client, not the bucket.
- **Who can download:** anyone with the link, from anywhere on the internet, with no login. A link holds
  256 random bits, so it can't be guessed. There is no network to keep it private, as a server has.
  Making that work means turning off this bucket's public-access block for a policy, so don't keep
  anything else in this bucket.
- **What's public:** on AWS, exactly `artifacts/*`, by [the policy above](#on-aws): anonymous `GetObject`,
  no listing, and neither `runs/` nor `repositories/`. A link's answer shows its repository's ID, run and
  attempt, in `x-amz-meta-run-scope`. On R2 the whole bucket is public unless
  [the WAF rule above](#on-r2) stops it. Without that rule, anyone who knows or guesses a repository's ID,
  a run's ID and an artifact's name can read its metadata, and with it its link. So guard that rule as
  you would the credentials.
- **Who can list:** only someone with the credentials. Clients read with signed requests.
- **An expired link:** can keep working until the next upload or the lifecycle rule removes it. See
  [Expiry](#expiry-with-a-bucket). A deleted or replaced artifact's link stops as its data goes, which
  on R2 needs [the cache rule above](#on-r2).
- **What a file can do:** it's served as `application/octet-stream`, as an attachment. S3 can't add the
  server's `X-Content-Type-Options` and `Content-Security-Policy` headers, and a browser that ignored
  the attachment would meet it on the bucket's origin, which holds nothing else.
- **What a name can do:** the same as with a server. Names reach a key only as their hash, or checked
  against the [name rule](#http-api) in `artifacts/<id>/<name>`, and whatever a bucket answers is held
  to those rules before it reaches a path.
- **What gets logged:** never a credential. Failures name a key, and S3's code and message, and never
  the rest of its answer, which can hold the access key's ID.

## Limits

- With a server, 2 GiB per file by default, checked from `Content-Length` and counted while streaming.
  A zip counts as one file.
- Under 4 GiB per upload from the action or the command, whatever the target allows: Node's `fetch`
  can't send more with the right length. Files in a zip can be larger, as long as the zip isn't. A bucket
  takes one `PUT` for it, with no multipart.
- 90 days' retention at most by default, and always with a bucket.
- One hour for a request to a server, enough for 2 GiB at about 5 Mbit/s. A slower upload is cut off.
- A run's list is answered in one response from a server, with no pages. A bucket's is read in pages,
  with one read per artifact.
- Five minutes idle on a server: a client that stops reading or sending is cut off, downloads included. A stalled
  download is cut off after 10 to 15 minutes, as Node restarts the timer while a write is pending.

## Not supported

A web UI, `Range` requests, Windows runners, resuming a download, merging the
artifacts of another run or repository, and a list of a run's earlier attempts where a later one holds
the name, or, with a bucket, multipart uploads, requests with OIDC of their own, or a bucket that also
holds other things.

## License

[MIT](LICENSE)
