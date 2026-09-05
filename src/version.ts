import packageJson from "../package.json" with { type: "json" };

/** Keep in sync with package.json — tests/version.test.ts pins this. */
export const PKG_VERSION = packageJson.version as string;
export const PKG_NAME = packageJson.name as string;
