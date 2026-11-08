import { readFileSync } from "node:fs";
import { resolve,join } from "node:path";
const root=resolve(import.meta.dir,"..");
const json=(file:string)=>JSON.parse(readFileSync(join(root,file),"utf8"));
const manifest=json("manifest.json");
if(process.env.GITHUB_REF_NAME!==manifest.version)throw Error("Release tag must equal manifest version, without a prefix");
if(json("package.json").version!==manifest.version||json("packages/mehrpele-cannoli/manifest.json").version!==manifest.version||json("versions.json")[manifest.version]!==manifest.minAppVersion)throw Error("Release metadata disagrees");
console.log("release: exact version tag accepted");
