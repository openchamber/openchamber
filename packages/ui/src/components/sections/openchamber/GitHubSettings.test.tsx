import React from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n";
import { useGitHubAuthStore } from "@/stores/useGitHubAuthStore";

import { GitHubSettings } from "./GitHubSettings";

const serverAuthState = useGitHubAuthStore.getInitialState();

const resetServerAuthState = () => {
  Object.assign(serverAuthState, {
    status: null,
    isLoading: false,
    hasChecked: false,
  });
};

const renderSettings = () =>
  renderToStaticMarkup(
    <I18nProvider>
      <GitHubSettings />
    </I18nProvider>,
  );

describe("GitHubSettings", () => {
  beforeEach(resetServerAuthState);
  afterEach(resetServerAuthState);

  test("stays hidden during the initial auth status load", () => {
    serverAuthState.isLoading = true;

    expect(renderSettings()).toBe("");
  });

  test("stays mounted while a checked status is refreshing, then shows reconnect state", () => {
    Object.assign(serverAuthState, {
      status: {
        connected: true,
        user: { login: "octocat" },
      },
      isLoading: true,
      hasChecked: true,
    });

    const refreshingMarkup = renderSettings();
    expect(refreshingMarkup).toContain("octocat");
    expect(refreshingMarkup).toContain("Disconnect");

    Object.assign(serverAuthState, {
      status: { connected: false },
      isLoading: false,
      hasChecked: true,
    });

    const disconnectedMarkup = renderSettings();
    expect(disconnectedMarkup).toContain("Not Connected");
    expect(disconnectedMarkup).toContain("Connect GitHub");
  });
});
