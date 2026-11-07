// Feasibility only: loads one engine inside a worker and runs hello world. The real worker is built in Task 3.
import { parentPort, workerData } from "node:worker_threads";

const out = [];
const which = workerData.engine;
try {
  if (which === "quickjs") {
    const { getQuickJS } = await import("quickjs-emscripten");
    const QuickJS = await getQuickJS();
    const vm = QuickJS.newContext();
    const r = vm.evalCode("1+1");
    out.push(String(vm.dump(r.value)));
    r.value.dispose();
    vm.dispose();
  } else if (which === "pyodide") {
    const { loadPyodide } = await import("pyodide");
    const py = await loadPyodide({ stdout: (s) => out.push(s) });
    await py.runPythonAsync("print(1+1)");
  } else if (which === "just-bash") {
    const { Bash } = await import("just-bash");
    const sh = new Bash();
    const r = await sh.exec("echo hi");
    out.push(r.stdout.trim());
  }
  parentPort.postMessage({ ok: true, out });
} catch (e) {
  parentPort.postMessage({ ok: false, error: String(e && e.stack ? e.stack : e) });
}
