/** What the owner sees in the corner while a tool runs: plain words, never raw arguments. */
export function toolLabel(name: string, args?: unknown): string {
  const city = (args as { city?: unknown } | null)?.city;
  if (name === "weather.get") return typeof city === "string" && city.trim() ? `Getting the weather for ${city.trim().slice(0, 40)}` : "Getting the weather";
  if (name === "system.info") return "Reading computer stats";
  if (name === "stage.clear") return "Clearing the screen";
  if (name.startsWith("stage.")) return "Creating a view";
  if (name === "camera.snap") return "Looking through the camera";
  if (name.startsWith("shell.")) return "Running a command";
  if (name.startsWith("fs.")) return "Working with files";
  if (name.startsWith("code.")) return "Running code";
  if (name.startsWith("memory.")) return "Using memory";
  if (name.startsWith("task")) return "Managing tasks";
  if (name.startsWith("plugin.")) return "Using a plugin";
  return `Using ${name.replace(/[._]/g, " ").slice(0, 40)}`;
}
