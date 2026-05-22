import { clerkSetup } from "@clerk/testing/playwright";
import { test as setup } from "@playwright/test";

setup("global clerk setup", async () => {
  await clerkSetup();
});
