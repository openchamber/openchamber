import React from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n";
import { GITHUB_SOURCE_CONTROL_IDENTITY } from "@/lib/source-control/identity";
import { getSourceControlAuthKey, useSourceControlAuthStore } from "@/stores/useSourceControlAuthStore";
import type { SourceControlAuthStatus } from "@/lib/api/types";

import { GitHubSettings } from "./GitHubSettings";

// Static rendering reads the store's server snapshot, which is its initial
// state, so the fixture is written onto that object rather than through
// setState. The key carries the runtime key, so it is computed per write.
const serverAuthState = useSourceControlAuthStore.getInitialState();

const setAuthEntry = (entry: {
  status: SourceControlAuthStatus | null;
  isLoading: boolean;
  hasChecked: boolean;
}) => {
  serverAuthState.entries[getSourceControlAuthKey(GITHUB_SOURCE_CONTROL_IDENTITY)] = entry;
};

const resetAuthState = () => {
  for (const key of Object.keys(serverAuthState.entries)) delete serverAuthState.entries[key];
};

const renderSettings = () =>
  renderToStaticMarkup(
    <I18nProvider>
      <GitHubSettings />
    </I18nProvider>,
  );

describe("GitHubSettings", () => {
  beforeEach(resetAuthState);
  afterEach(resetAuthState);

  test("stays hidden during the initial auth status load", () => {
    setAuthEntry({ status: null, isLoading: true, hasChecked: false });

    expect(renderSettings()).toBe("");
  });

  test("stays mounted while a checked status is refreshing, then shows reconnect state", () => {
    setAuthEntry({
      status: {
        ...GITHUB_SOURCE_CONTROL_IDENTITY,
        status: "connected",
        connected: true,
        user: { ...GITHUB_SOURCE_CONTROL_IDENTITY, id: "user-one", username: "octocat" },
        accounts: [{
          id: "account-one",
          credentialId: "account-one",
          credentialRevision: 1,
          providerUserId: "github.com#user-one",
          providerUserStatus: "available",
          user: { ...GITHUB_SOURCE_CONTROL_IDENTITY, id: "user-one", username: "octocat" },
          current: true,
          source: "oauth",
          status: "valid",
        }],
      },
      isLoading: true,
      hasChecked: true,
    });

    const refreshingMarkup = renderSettings();
    expect(refreshingMarkup).toContain("octocat");

    setAuthEntry({
      status: { ...GITHUB_SOURCE_CONTROL_IDENTITY, status: "disconnected", connected: false, accounts: [] },
      isLoading: false,
      hasChecked: true,
    });

    const disconnectedMarkup = renderSettings();
    expect(disconnectedMarkup).toContain("Not Connected");
    expect(disconnectedMarkup).toContain("Connect GitHub");
  });
});
