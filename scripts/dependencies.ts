import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
const root=realpathSync(resolve(import.meta.dir,".."));
const json=(path:string)=>JSON.parse(readFileSync(path,"utf8"));
const pkg=json(join(root,"package.json"));
const workspaces=["packages/mehrpele-cannoli","packages/mehrpele-api","packages/cannoli-core"];
if(JSON.stringify(pkg.workspaces)!==JSON.stringify(workspaces))throw Error("Standalone workspace boundary changed");
let checked=0;
for(const context of ["",...workspaces]){
 const manifest=json(join(root,context,"package.json"));
 for(const [name,version] of Object.entries({...manifest.dependencies,...manifest.devDependencies})){
  const candidates=[join(root,context,"node_modules",name,"package.json"),join(root,"node_modules",name,"package.json")];
  const file=candidates.find(existsSync);if(!file)throw Error(`Missing declared local dependency: ${context}/${name}`);
  const actual=realpathSync(file);if(!actual.startsWith(root+"/"))throw Error(`Dependency escapes standalone install: ${name}`);
  const installed=json(actual);
  if(installed.name!==name)throw Error(`Dependency name differs: ${name}`);
  if(!/^(?:workspace:|file:)/.test(String(version))&&installed.version!==version)throw Error(`Dependency pin differs: ${name}`);
  checked++;
 }
}
console.log(`dependencies: ${checked} declared dependencies resolve inside the isolated install`);
