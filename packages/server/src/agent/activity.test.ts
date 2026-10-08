import { describe, expect, it } from "vitest";
import { toolLabel } from "./activity";

describe("toolLabel", () => {
  it("describes tools in plain words", () => {
    expect(toolLabel("weather.get", { city: "Pune" })).toBe("Getting the weather for Pune");
    expect(toolLabel("weather.get", {})).toBe("Getting the weather");
    expect(toolLabel("system.info")).toBe("Reading computer stats");
    expect(toolLabel("stage.show", {})).toBe("Creating a view");
    expect(toolLabel("stage.clear")).toBe("Clearing the screen");
    expect(toolLabel("shell.run", { command: "del *" })).toBe("Running a command"); // never the raw arguments
    expect(toolLabel("plugin.unit-converter.convert")).toBe("Using a plugin");
  });

  it("falls back to the tool's name, kept short", () => {
    expect(toolLabel("odd_tool.name")).toBe("Using odd tool name");
    expect(toolLabel("x".repeat(200)).length).toBeLessThan(60);
  });
});
