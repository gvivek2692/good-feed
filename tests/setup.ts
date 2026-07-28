import "@testing-library/jest-dom/vitest";
// Loads DATABASE_URL so integration tests can reach the local Postgres.
// Tests that need it skip themselves when it is absent.
import "../src/lib/env";
