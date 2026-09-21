# OpenVSX Docker Image

`Dockerfile` builds an OpenVSX server image with the default web UI bundled in,
on top of the published [`openvsx-server`](https://github.com/orgs/eclipse-openvsx/packages/container/package/openvsx-server)
image. It does not bake in any application configuration — the same image is
meant to be reused across environments by mounting a config file into it at
container start.

## Build

```bash
./build.sh
```

This builds `openvsx:<latest release tag>`. Pass `OPENVSX_VERSION` explicitly
to pin a different release:

```bash
docker build -t openvsx:v0.30.0 --build-arg OPENVSX_VERSION=v0.30.0 .
```

## Run

Edit `configuration/application.yml` to point at your database and set any
other properties you need (see [Open VSX Configuration
Properties](../../doc/configuration.md)), then mount it read-only into the
container's config directory:

```bash
docker run -p 8080:8080 \
  -v "$(pwd)/configuration/application.yml:/home/openvsx/server/config/application.yml:ro" \
  openvsx:<tag>
```

Changing the configuration only means editing that file and restarting the
container — the image itself never needs to be rebuilt for a config change,
only for a new OpenVSX version or a different web UI bundle.
