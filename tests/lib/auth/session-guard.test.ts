/**
 * A server action is a public HTTP endpoint. The guard that keeps one user from
 * writing rows on another's behalf is `getSessionUserId()`, so it is tested
 * directly rather than inferred from the UI disabling a button.
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.fn();
const setInteractionMock = vi.fn();

vi.mock("@/lib/auth/config", () => ({ auth: authMock }));
vi.mock("@/lib/db/interactions", () => ({ setInteraction: setInteractionMock }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { toggleRead, toggleSaved } = await import("@/app/actions/interactions");

describe("interaction server actions", () => {
  beforeEach(() => {
    authMock.mockReset();
    setInteractionMock.mockReset();
    setInteractionMock.mockResolvedValue(true);
  });

  it("refuses to write when there is no session", async () => {
    authMock.mockResolvedValue(null);

    const result = await toggleSaved("item-1", true);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("unauthenticated");
    expect(setInteractionMock).not.toHaveBeenCalled();
  });

  /** A session object without an id is not a usable identity. */
  it("refuses to write when the session carries no user id", async () => {
    authMock.mockResolvedValue({ user: { name: "No Id" } });

    const result = await toggleRead("item-1", true);

    expect(result.ok).toBe(false);
    expect(setInteractionMock).not.toHaveBeenCalled();
  });

  /**
   * The user id must come from the session, never from the caller — otherwise
   * the endpoint would let anyone write rows for anyone.
   */
  it("writes using the session's user id, not any caller-supplied value", async () => {
    authMock.mockResolvedValue({ user: { id: "user-from-session" } });

    const result = await toggleSaved("item-1", true);

    expect(result.ok).toBe(true);
    expect(setInteractionMock).toHaveBeenCalledWith("user-from-session", "item-1", "SAVED", true);
  });

  it("passes the clearing case through rather than ignoring it", async () => {
    authMock.mockResolvedValue({ user: { id: "user-1" } });
    setInteractionMock.mockResolvedValue(false);

    const result = await toggleRead("item-9", false);

    expect(setInteractionMock).toHaveBeenCalledWith("user-1", "item-9", "READ", false);
    expect(result.active).toBe(false);
  });
});
