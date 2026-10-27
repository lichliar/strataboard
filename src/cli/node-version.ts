export const SUPPORTED_NODE_RANGE = "^22.22.2 || ^24.15.0 || >=26.0.0";

export function assertSupportedNodeVersion(version = process.versions.node): void {
  const [major, minor, patch] = version.split(".").map((part) => Number(part));
  const supported =
    major >= 26 ||
    (major === 22 && (minor > 22 || (minor === 22 && patch >= 2))) ||
    (major === 24 && (minor > 15 || (minor === 15 && patch >= 0)));
  if (!supported || ![major, minor, patch].every(Number.isFinite)) {
    throw new Error(`StrataBoard CLI 需要 Node ${SUPPORTED_NODE_RANGE}（当前 ${version}）。`);
  }
}
