import { describe, expect, it } from "vitest";
import {
  initialVersionCheckState,
  isStaleBuild,
  parseBuildNumber,
  versionCheckReducer,
} from "../versionCheck";

describe("versionCheck (pure)", () => {
  describe("parseBuildNumber", () => {
    it("parses a numeric string into a positive int", () => {
      expect(parseBuildNumber("42")).toBe(42);
    });
    it("parses a number", () => {
      expect(parseBuildNumber(7)).toBe(7);
    });
    it("returns null for empty / non-numeric / zero / negative", () => {
      expect(parseBuildNumber("")).toBeNull();
      expect(parseBuildNumber("abc")).toBeNull();
      expect(parseBuildNumber("0")).toBeNull();
      expect(parseBuildNumber("-3")).toBeNull();
      expect(parseBuildNumber(null)).toBeNull();
      expect(parseBuildNumber(undefined)).toBeNull();
    });
    it("ignores trailing junk after a leading integer", () => {
      expect(parseBuildNumber("42 (build)")).toBe(42);
    });
  });

  describe("isStaleBuild", () => {
    it("is stale only when latest is strictly greater than current", () => {
      expect(isStaleBuild(10, 11)).toBe(true);
      expect(isStaleBuild(11, 11)).toBe(false);
      expect(isStaleBuild(12, 11)).toBe(false);
    });
    it("is not stale when either side is unknown (no false banner)", () => {
      expect(isStaleBuild(null, 11)).toBe(false);
      expect(isStaleBuild(10, null)).toBe(false);
      expect(isStaleBuild(null, null)).toBe(false);
    });
  });

  describe("versionCheckReducer", () => {
    it("check-start moves to checking", () => {
      const s = versionCheckReducer(initialVersionCheckState, { type: "check-start" });
      expect(s.status).toBe("checking");
      expect(s.error).toBeNull();
    });
    it("check-success with an older installed build => stale + records latest/installUrl", () => {
      const s = versionCheckReducer(initialVersionCheckState, {
        type: "check-success",
        installedBuildNumber: 10,
        latestBuildNumber: 11,
        installUrl: "https://host/field/install",
      });
      expect(s.status).toBe("stale");
      expect(s.latestBuildNumber).toBe(11);
      expect(s.installUrl).toBe("https://host/field/install");
    });
    it("check-success with current/equal build => current", () => {
      const s = versionCheckReducer(initialVersionCheckState, {
        type: "check-success",
        installedBuildNumber: 11,
        latestBuildNumber: 11,
        installUrl: "https://host/field/install",
      });
      expect(s.status).toBe("current");
    });
    it("check-success with unknown installed build => current (no false banner)", () => {
      const s = versionCheckReducer(initialVersionCheckState, {
        type: "check-success",
        installedBuildNumber: null,
        latestBuildNumber: 11,
        installUrl: "https://host/field/install",
      });
      expect(s.status).toBe("current");
    });
    it("check-error records a message and sets error status", () => {
      const s = versionCheckReducer(initialVersionCheckState, {
        type: "check-error",
        error: "boom",
      });
      expect(s.status).toBe("error");
      expect(s.error).toBe("boom");
    });
    it("dismiss clears a stale banner to current", () => {
      const stale = versionCheckReducer(initialVersionCheckState, {
        type: "check-success",
        installedBuildNumber: 10,
        latestBuildNumber: 11,
        installUrl: "u",
      });
      const s = versionCheckReducer(stale, { type: "dismiss" });
      expect(s.status).toBe("current");
      // latest metadata is retained so a re-check isn't required to re-show.
      expect(s.latestBuildNumber).toBe(11);
    });
    it("dismiss is a no-op when not stale", () => {
      const s = versionCheckReducer(initialVersionCheckState, { type: "dismiss" });
      expect(s).toEqual(initialVersionCheckState);
    });
    it("reset returns to the initial state", () => {
      const stale = versionCheckReducer(initialVersionCheckState, {
        type: "check-success",
        installedBuildNumber: 10,
        latestBuildNumber: 11,
        installUrl: "u",
      });
      expect(versionCheckReducer(stale, { type: "reset" })).toEqual(initialVersionCheckState);
    });
  });
});
