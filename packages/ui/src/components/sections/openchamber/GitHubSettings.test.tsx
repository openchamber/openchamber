import React from "react";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n";

type GitHubAuthTestState = {
  status: {
    connected: boolean;
    user?: { login: string };
  } | null;
  isLoading: boolean;
  hasChecked: boolean;
  refreshStatus: () => Promise<null>;
  setStatus: () => void;
};

let authState: GitHubAuthTestState;

mock.module("@/contexts/runtimeAPIRegistry", () => ({
  getRegisteredRuntimeAPIs: () => null,
}));

mock.module("@/stores/useGitHubAuthStore", () => ({
  useGitHubAuthStore: (selector: (state: GitHubAuthTestState) => unknown) =>
    selector(authState),
}));

mock.module("@/lib/device", () => ({
  useDeviceInfo: () => ({
    isMobile: false,
    isTablet: false,
    isDesktop: true,
    deviceType: "desktop" as const,
    screenWidth: 1024,
    breakpoint: "lg" as const,
    hasTouchInput: false,
    hasTouchOnlyPointer: false,
  }),
}));

const { GitHubSettings } = await import("./GitHubSettings");

const renderSettings = () =>
  renderToStaticMarkup(
    <I18nProvider>
      <GitHubSettings />
    </I18nProvider>,
  );

describe("GitHubSettings", () => {
  beforeEach(() => {
    authState = {
      status: null,
      isLoading: false,
      hasChecked: false,
      refreshStatus: async () => null,
      setStatus: () => {},
    };
  });

  test("stays hidden during the initial auth status load", () => {
    authState.isLoading = true;

    expect(renderSettings()).toBe("");
  });

  test("stays mounted while a checked status is refreshing, then shows reconnect state", () => {
    authState = {
      ...authState,
      status: {
        connected: true,
        user: { login: "octocat" },
      },
      isLoading: true,
      hasChecked: true,
    };

    const refreshingMarkup = renderSettings();
    expect(refreshingMarkup).toContain("octocat");
    expect(refreshingMarkup).toContain("Disconnect");

    authState = {
      ...authState,
      status: { connected: false },
      isLoading: false,
      hasChecked: true,
    };

    const disconnectedMarkup = renderSettings();
    expect(disconnectedMarkup).toContain("Not Connected");
    expect(disconnectedMarkup).toContain("Connect GitHub");
  });
});
