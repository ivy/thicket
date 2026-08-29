/**
 * The platforms the fleet runs on, and what each toolchain calls them.
 *
 * One table so a compile, a release archive and a `mise install` cannot
 * disagree about which platform they mean.
 */
export interface Platform {
  /** Asset and directory name: what mise's autodetector reads. */
  readonly name: string;
  /** `bun build --compile --target=`. */
  readonly bunTarget: string;
  readonly goos: string;
  readonly goarch: string;
}

export const PLATFORMS: readonly Platform[] = [
  { name: "macos-arm64", bunTarget: "bun-darwin-arm64", goos: "darwin", goarch: "arm64" },
  { name: "linux-x64", bunTarget: "bun-linux-x64", goos: "linux", goarch: "amd64" },
];

/** The platform this machine is, or undefined if the fleet has no such host. */
export function hostPlatform(): Platform | undefined {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const os = process.platform === "darwin" ? "macos" : process.platform;
  return PLATFORMS.find((p) => p.name === `${os}-${arch}`);
}
