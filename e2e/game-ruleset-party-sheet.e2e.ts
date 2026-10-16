import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { parseRulesetDefinition, readRulesetPartySheet } from "@marinara-engine/shared";
import { seedUIState } from "./ui-state-fixture.js";
import { prepareViteFixtureDependencies } from "./vite-fixture-dependencies.js";

const raw = JSON.parse(readFileSync(new URL("../docs/examples/rulesets/ember-roads.json", import.meta.url), "utf8"));
raw.party = {
  label: "Crew",
  fields: [
    { id: "heat", label: "Heat", type: "number", min: 0, max: 9, default: 2 },
    { id: "upgrades", label: "Upgrades", type: "text", maxLength: 100, default: "Hidden vault" },
  ],
  pools: [{ id: "coin", label: "Coin", max: { const: 8 } }],
};
const parsed = parseRulesetDefinition(raw);
if (!parsed.ok) throw new Error(parsed.issues.join("; "));
const definition = parsed.definition;
const envelope = readRulesetPartySheet(definition, null);
const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

for (const theme of ["light", "dark"] as const) {
  test(`Party sheet shows shared values read-only and reports unreadable data (${theme})`, async ({ page }, info) => {
    await page.route("**/api/app-settings/ui", (route) => route.fulfill({ json: { value: "" } }));
    await seedUIState(page, {
      theme,
      hasCompletedOnboarding: true,
      sidebarOpen: false,
      rightPanelOpen: false,
      chibiProfessorMariEnabled: false,
    });
    await page.addInitScript((version) => localStorage.setItem("marinara:whats-new:seen-version", version), version);
    await page.goto("/");
    await prepareViteFixtureDependencies(page);
    await page.evaluate(
      async ({ definition, envelope }) => {
        const dependencyUrl = window.__viteFixtureDependencyUrl;
        const { default: React } = await import(dependencyUrl("react"));
        const { default: ReactDOM } = await import(dependencyUrl("react-dom_client"));
        const { QueryClient, QueryClientProvider } = await import(dependencyUrl("@tanstack_react-query"));
        const { GameRulesetPartySheet } = await import("/src/components/game/GameRulesetSheet.tsx" as string);
        const container = document.createElement("div");
        container.style.cssText =
          "position:fixed;inset:0;z-index:10000;overflow:auto;padding:16px;background:var(--background);color:var(--foreground)";
        document.body.append(container);
        // The party sheet saves through a React Query mutation, so it renders inside the app's provider.
        ReactDOM.createRoot(container).render(
          React.createElement(
            QueryClientProvider,
            { client: new QueryClient() },
            React.createElement(
              "div",
              { style: { maxWidth: "320px" } },
              React.createElement(
                "div",
                { "data-testid": "party" },
                React.createElement(GameRulesetPartySheet, {
                  definition,
                  stored: envelope,
                  live: { pools: { coin: { value: 6 } } },
                }),
              ),
              React.createElement(
                "div",
                { "data-testid": "unreadable" },
                React.createElement(GameRulesetPartySheet, {
                  definition,
                  stored: { broken: true },
                }),
              ),
            ),
          ),
        );
      },
      { definition, envelope },
    );
    const party = page.getByTestId("party");
    await expect(party.getByLabel("Coin for Crew", { exact: true })).not.toBeVisible();
    await party.locator("summary").click();
    await expect(party.getByLabel("Coin for Crew", { exact: true })).toHaveValue("6");
    await expect(party.getByLabel("Coin for Crew", { exact: true })).toBeDisabled();
    await expect(party.getByRole("button", { name: "Edit sheet" })).toHaveCount(0);
    await expect(party.getByText("Heat", { exact: true })).toBeVisible();
    await expect(party.getByText("Hidden vault", { exact: true })).toBeVisible();
    const unreadable = page.getByTestId("unreadable");
    await unreadable.locator("summary").click();
    await expect(unreadable.getByText("This party sheet cannot be read by the current ruleset.")).toBeVisible();
    await page.screenshot({ path: info.outputPath(`party-sheet-${theme}.png`), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}
