/**
 * The release this binary was built from.
 *
 * A version that has to be remembered at tag time will be wrong at some tag,
 * so it comes from the build: `bun build --define` stamps it into the
 * compiled binaries, and anything running from a working tree says so
 * instead of claiming a release it is not.
 */
declare const THICKET_BUILD_VERSION: string | undefined;

export const DEVELOPMENT_VERSION = "0.0.0-dev";

export function thicketVersion(): string {
  return typeof THICKET_BUILD_VERSION === "string" && THICKET_BUILD_VERSION !== ""
    ? THICKET_BUILD_VERSION
    : DEVELOPMENT_VERSION;
}
