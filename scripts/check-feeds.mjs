import { collectArticles } from "../src/feeds.ts";
import { defaultSettings } from "../src/settings.ts";
const started = performance.now();
const result = await collectArticles(defaultSettings.sources,defaultSettings);
console.log(JSON.stringify({elapsedMs:Math.round(performance.now()-started),candidates:result.articles.length,errors:result.errors,sample:result.articles.slice(0,5).map(a=>({source:a.sourceName,title:a.title,url:a.url}))},null,2));
