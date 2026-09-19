import { chromium } from 'playwright-core';
import { pathToFileURL } from 'node:url';
const b=await chromium.launch({channel:'chrome', headless:true});
const p=await (await b.newContext({viewport:{width:1200,height:630}, deviceScaleFactor:1})).newPage();
await p.goto(pathToFileURL(process.argv[2]).href); await p.waitForTimeout(1500); await p.evaluate(()=>document.fonts.ready);
const jpg=process.argv[3].endsWith('.jpg');
await p.screenshot(jpg?{path:process.argv[3], type:'jpeg', quality:88}:{path:process.argv[3], type:'png'});
await b.close();
