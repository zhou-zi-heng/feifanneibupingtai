import {spawnSync} from 'node:child_process';
import {existsSync,writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
if(!existsSync('.dev.vars'))writeFileSync('.dev.vars',`TOKEN_KEY=${randomBytes(32).toString('base64')}\nLOCAL_DEV=true\nOWNER_EMAIL=owner@example.test\n`);
spawnSync(process.execPath,['scripts/configure.mjs','--local'],{stdio:'inherit'});
const command=process.platform==='win32'?'node_modules/wrangler/bin/wrangler.js':'node_modules/wrangler/bin/wrangler.js';
spawnSync(process.execPath,[command,'dev','--config','wrangler.generated.jsonc','--ip','127.0.0.1','--port','8890'],{stdio:'inherit'});
