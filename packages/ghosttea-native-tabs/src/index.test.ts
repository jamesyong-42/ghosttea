import { expect, test } from "vitest";
import { addonPath, loadNativeTabs } from "./index.js";

test("off macOS there is nothing to load, by contract", () => {
  expect(addonPath({ platform: "linux" })).toBeNull();
  expect(addonPath({ platform: "win32" })).toBeNull();
  expect(loadNativeTabs({ platform: "linux" })).toBeNull();
  expect(loadNativeTabs({ platform: "win32" })).toBeNull();
});

test("on macOS the prebuild either resolves or names what produces it", () => {
  // Inside the repository both states are legitimate: the prebuild exists
  // after `npm run build:ghosttea-native-tabs` and does not on a fresh
  // checkout, because staging belongs to the release workflow. What must
  // hold is that presence yields a loadable addon and absence names the
  // command that produces one.
  let path: string | null;
  try {
    path = addonPath({ platform: "darwin" });
  } catch (error) {
    expect(String(error)).toMatch(/build:ghosttea-native-tabs/);
    return;
  }
  expect(path).toMatch(/ghosttea_native_tabs\.node$/);
  if (process.platform === "darwin") {
    const tabs = loadNativeTabs({ platform: "darwin" });
    expect(typeof tabs?.tabOrder).toBe("function");
  }
});
