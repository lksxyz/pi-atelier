const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const pkgs = process.argv.slice(2);
for (const p of pkgs) {
  const pj = JSON.parse(fs.readFileSync(path.join(p, "package.json"), "utf8"));
  const scr = pj.scripts || {};
  if (!scr.test) { console.log(`===== ${pj.name}: no test script, skip`); continue; }
  console.log(`===== ${pj.name} :: ${scr.test}`);
  try {
    execSync(scr.test, { cwd: p, encoding: "utf8", stdio: "pipe" });
    console.log("PASS");
  } catch (e) {
    console.log("FAIL rc=" + e.status);
    const txt = (e.stdout || "") + (e.stderr || "");
    console.log(txt.split("\n").filter(l => /FAIL|failed|✗|Error|Tests  |no tests/.test(l)).slice(-12).join("\n"));
  }
}