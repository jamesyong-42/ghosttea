import { join } from "node:path";

export const PROFILE_ENV = "ELECTRON_GHOSTTY_PROFILE";
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface DesktopProfile {
  name: string;
  root: string;
  electronData: string;
  truffleState: string;
}

export function parseProfileName(value: string | undefined): string | undefined {
  const name = value?.trim();
  if (!name) return undefined;
  if (!PROFILE_PATTERN.test(name)) {
    throw new Error(
      `${PROFILE_ENV} must be 1-64 characters, start with a letter or number, and contain only letters, numbers, '.', '_', or '-'`,
    );
  }
  return name;
}

export function desktopProfile(defaultUserData: string, value: string | undefined): DesktopProfile {
  const name = parseProfileName(value) ?? "default";
  const root = name === "default" ? defaultUserData : join(defaultUserData, "profiles", name);
  return {
    name,
    root,
    electronData: name === "default" ? defaultUserData : join(root, "electron"),
    truffleState: join(root, "truffle"),
  };
}
