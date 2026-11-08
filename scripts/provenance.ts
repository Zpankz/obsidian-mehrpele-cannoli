import { readFileSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
const root=resolve(import.meta.dir,".."),core=join(root,"packages/cannoli-core");
const hash=(value:Buffer)=>createHash("sha256").update(value).digest("hex");
const bytes=readFileSync(join(core,"UPSTREAM.json"));
if(hash(bytes)!=="5fbe9f42cc032b8638534f8983036ead7052d4d15165d97f3e112980f21d1b78")throw Error("Provenance manifest changed");
const manifest=JSON.parse(bytes.toString());
const expected=new Set(Object.keys(manifest.files));
for(const [file,wanted] of Object.entries(manifest.files)) {
 if(file.startsWith("/")||file.split("/").some((s:string)=>!s||s===".."||s===".")||file.includes("\\"))throw Error("Unsafe provenance path");
 const full=join(core,file);if(!lstatSync(full).isFile()||lstatSync(full).isSymbolicLink()||!realpathSync(full).startsWith(core+"/"))throw Error("Nonregular canonical file");
 if(hash(readFileSync(full))!==wanted)throw Error(`Canonical file changed: ${file}`);
}
function walk(dir:string,prefix:string){for(const name of readdirSync(dir)){const rel=prefix+"/"+name,full=join(core,rel),st=lstatSync(full);if(st.isSymbolicLink())throw Error("Canonical symlink");if(st.isDirectory())walk(full,rel);else if(!expected.has(rel))throw Error(`Extra canonical file: ${rel}`);}}
for(const dir of ["src","test"])walk(join(core,dir),dir);
for(const [file,wanted] of Object.entries({"package.json":"7b63f4db38548130e7830979f8d5f3fae6558672761bda8267f74f349db006ca","packages/mehrpele-cannoli/package.json":"eefc1f5748736aa35ae08fdbe19a01d581565d28065326d33f982d61129a619b","packages/mehrpele-api/package.json":"b8c905981037a9c319ec7dd2e390655197fe141476d2fa12401cb3046dc56d44","packages/cannoli-core/package.json":"bef39414cc5132e907ab2d515ae83c5c13d6c0c6bed5bdc471bbb550a4e013a8"}))if(hash(readFileSync(join(root,file)))!==wanted)throw Error(`Generated manifest changed: ${file}`);
console.log(`provenance: ${expected.size} canonical files match ${manifest.sha}`);
