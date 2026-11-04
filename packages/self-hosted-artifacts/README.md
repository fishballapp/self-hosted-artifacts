# self-hosted-artifacts

**GitHub Actions artifacts on your own disk or bucket: a small file server, and a client for it or S3.**

```sh
npx self-hosted-artifacts serve --config ./config.json
```

With a bucket, the server can be a Cloudflare Worker, whose whole code is:

```js
export { default } from 'self-hosted-artifacts/worker';
```

See the [self-hosted-artifacts README](https://github.com/fishballapp/self-hosted-artifacts#readme)
for the config file, setting up a bucket, the actions, the HTTP contract and the security model.
