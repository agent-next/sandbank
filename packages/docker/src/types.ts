export interface DockerAdapterConfig {
  /** docker CLI binary. Defaults to `docker` on PATH (honors DOCKER_HOST / contexts). */
  binary?: string

  /** Image used when `image` is omitted. Defaults to `ubuntu:24.04`. */
  defaultImage?: string

  /** Host interface that published ports bind to. Defaults to `127.0.0.1`. */
  bindHost?: string

  /** Host name used in `exposePort` URLs. Defaults to `127.0.0.1`. */
  publicHost?: string

  /** Extra `docker run` flags, e.g. `['--gpus', 'all']` or `['--network', 'none']`. */
  runArgs?: string[]
}
