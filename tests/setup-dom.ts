import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Without this, each render stacks onto the previous DOM and `screen` queries
// match elements from earlier tests.
afterEach(() => {
  cleanup();
});