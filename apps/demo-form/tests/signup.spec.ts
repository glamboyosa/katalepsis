import { expect, test } from "@playwright/test";

test.describe("signup form", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("empty submission shows a required-field error", async ({ page }) => {
    await page.getByRole("button", { name: "Sign up" }).click();
    await expect(page.getByRole("alert")).toHaveText(/required/i, { timeout: 2_000 });
  });

  test("valid submission shows a confirmation", async ({ page }) => {
    await page.getByLabel("Name").fill("Test Person");
    await page.getByLabel("Email").fill("test.person@example.com");
    await page.getByRole("button", { name: "Sign up" }).click();
    await expect(page.getByRole("status")).toHaveText("Thanks, you're signed up.");
  });

  test("malformed email shows an email error and does not submit", async ({ page }) => {
    await page.getByLabel("Name").fill("Test Person");
    await page.getByLabel("Email").fill("not-an-email");
    await page.getByRole("button", { name: "Sign up" }).click();
    await expect(page.getByRole("alert")).toHaveText("Enter a valid email address.");
    await expect(page.getByRole("status")).toBeHidden();
  });
});
